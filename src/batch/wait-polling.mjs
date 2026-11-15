// The wait polling of one batch: blocked issues and pending owner decisions are re-checked on a
// monotonic interval, and a recorded child that this process did not spawn keeps its slot until its
// process ends (adr/0110-release-batch-slots-on-owner-decisions.md decisions 1 and 5).
import { mapInBatches } from "../lib/map-in-batches.mjs";
import { ownerAlive } from "../lib/process-identity.mjs";
import { logInfo, logWarn } from "../lib/log.mjs";
import { blockedNumbers } from "./eligibility.mjs";
import { readGhJson } from "./gh-read.mjs";
import { readLoop } from "./store.mjs";

/** The wait between two re-checks of a blocked issue (adr/0110-release-batch-slots-on-owner-decisions.md decision 5). */
export const POLL_INTERVAL_MS = 15_000;
/** The bound on one poll read of the wait state. */
const POLL_READ_TIMEOUT_MS = 60_000;
/** The most independent reads in flight at once. */
const READ_BATCH_SIZE = 4;

/**
 * Waits one poll interval on the monotonic clock. An abort ends the wait at once without an error,
 * so the caller keeps its own cancel identity. Tests inject `now` and `sleep`.
 */
async function pollWait(ms, signal, { now, sleep }) {
  const deadline = now() + ms;
  while (!signal?.aborted) {
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, 1000), signal);
  }
}

/**
 * The wait-polling subsystem of one batch. Every dependency is explicit, so the subsystem holds no
 * supervisor closure. `waiting`, `pendingDecisions`, `slots`, `remaining`, and `loops` are the
 * shared sets and map that the supervisor owns and this subsystem updates in place.
 */
export function createWaitPolling({
  runsRoot,
  batchId,
  repo,
  gh,
  signal,
  issues,
  waiting,
  pendingDecisions,
  slots,
  remaining,
  loops,
  active,
  clock,
  pollIntervalMs,
  changeLoop,
  notify,
  progress,
  applyDecisionAnswer,
  withLoopResult,
  isLive,
  isStopped,
  readLoopRecord = readLoop,
  ownerAliveFn = ownerAlive,
  ghRead = readGhJson,
  mapBatches = mapInBatches,
}) {
  /**
   * One wait read of an issue: its state and its open blockers. An empty or unreadable reply
   * throws, and the caller retries on the next poll.
   */
  const readWaitState = async (issue) => {
    let value;
    try {
      value = await ghRead(
        gh,
        ["issue", "view", String(issue), "--json", "state,blockedBy"],
        repo,
        { signal, timeoutMs: POLL_READ_TIMEOUT_MS },
      );
    } catch (err) {
      if (err?.kind === "empty") throw new Error("exit unknown");
      throw err;
    }
    const nodes = blockedNumbers(value?.blockedBy);
    if (typeof value?.state !== "string" || nodes === null) {
      throw new Error("the wait read returned an unreadable value");
    }
    const open = nodes
      .filter((node) => String(node?.state ?? "").toUpperCase() === "OPEN")
      .map((node) => node?.number)
      .filter(Number.isInteger);
    return { state: value.state, open };
  };

  // Applies one wait read in checkpoint order. A read that failed keeps the issue waiting.
  const applyWaitRead = async (issue, read) => {
    if (String(read.state).toUpperCase() !== "OPEN") {
      await changeLoop(issue, {
        status: "skipped",
        skipReason: "closed",
        reason: `the issue state is ${read.state}`,
        blockingIssues: [],
        pid: null,
        startTime: null,
      });
      progress(`issue ${issue}: skipped (closed: the issue state is ${read.state})`);
      return "done";
    }
    if (read.open.length > 0) {
      const changed = await changeLoop(issue, {
        blockingIssues: read.open,
        reason: `open blocking issues: ${read.open.join(", ")}`,
      });
      if (changed) {
        await notify({
          kind: "merge-required",
          title: "Batch merge required",
          text: `Batch ${batchId} issue ${issue} waits for the merge of blocking issue(s) ${read.open.join(", ")}.`,
        });
      }
      return "wait";
    }
    await changeLoop(issue, {
      status: "queued",
      skipReason: null,
      reason: null,
      blockingIssues: [],
      pid: null,
      startTime: null,
    });
    logInfo(`issue ${issue}: blockers closed. Queued for launch`);
    return "ready";
  };

  const refreshWaiting = async () => {
    const waitingIssues = [...waiting];
    const outcomes = await mapBatches(waitingIssues, READ_BATCH_SIZE, (issue) =>
      readWaitState(issue).then(
        (read) => ({ read }),
        (error) => ({ error }),
      ),
    );
    for (let index = 0; index < waitingIssues.length; index += 1) {
      const issue = waitingIssues[index];
      const outcome = outcomes[index];
      let result;
      if (outcome.error === undefined) {
        result = await applyWaitRead(issue, outcome.read);
      } else if (isStopped()) {
        result = "wait";
      } else {
        logWarn(
          `issue ${issue}: the wait read failed: ${outcome.error.message}. Retrying on the next poll`,
        );
        result = "wait";
      }
      if (result === "done") waiting.delete(issue);
      else if (result === "ready") {
        waiting.delete(issue);
        remaining.add(issue);
      }
    }
  };

  // A cached snapshot is stale once another write replaced the in-memory loop.
  const newestRead = async (issue, reads) => {
    const cached = reads?.get(issue);
    if (cached !== undefined && cached === loops.get(issue)) return cached;
    return await readLoopRecord(runsRoot, batchId, issue);
  };

  const refreshPendingDecisions = async (reads = null) => {
    for (const issue of pendingDecisions) {
      const current = await newestRead(issue, reads);
      if (current === null) continue;
      loops.set(issue, current);
      if (current.status !== "needs-owner") {
        pendingDecisions.delete(issue);
        if (current.status === "queued") remaining.add(issue);
        continue;
      }
      if (isLive(current)) {
        if (await ownerAliveFn({ pid: current.pid, startTime: current.startTime })) {
          slots.add(issue);
          continue;
        }
        slots.delete(issue);
      }
      const applied = await withLoopResult(issue, () => applyDecisionAnswer(issue, current));
      if (applied === null) continue;
      if (applied.kind === "resume") {
        pendingDecisions.delete(issue);
        remaining.add(issue);
      } else if (applied.kind === "terminal") {
        pendingDecisions.delete(issue);
      }
    }
  };

  const syncFromDisk = async () => {
    const readIssues = issues();
    const results = await mapBatches(readIssues, READ_BATCH_SIZE, (issue) =>
      readLoopRecord(runsRoot, batchId, issue),
    );
    const reads = new Map();
    for (let index = 0; index < readIssues.length; index += 1) {
      const issue = readIssues[index];
      const current = results[index];
      reads.set(issue, current);
      if (current !== null) loops.set(issue, current);
    }
    return reads;
  };

  // A recorded child that this process did not spawn holds its slot until its process ends.
  const refreshHeld = async (reads = null) => {
    for (const issue of slots) {
      if (active.has(issue)) continue;
      const current = await newestRead(issue, reads);
      if (current === null || !isLive(current)) {
        slots.delete(issue);
        continue;
      }
      if (!(await ownerAliveFn({ pid: current.pid, startTime: current.startTime }))) {
        slots.delete(issue);
      }
    }
  };

  const hasRecordedHeld = () => slots.size > active.size;

  /** Runs the poll refresh steps in their checkpoint order. */
  const poll = async ({ waiting: includeWaiting = true } = {}) => {
    const reads = await syncFromDisk();
    await refreshHeld(reads);
    if (includeWaiting) await refreshWaiting();
    await refreshPendingDecisions(reads);
  };

  let nextPoll = 0;
  let pollLogged = false;

  return {
    readWaitState,
    applyWaitRead,
    refreshWaiting,
    refreshPendingDecisions,
    refreshHeld,
    syncFromDisk,
    poll,
    /** Starts the first poll interval at the current clock, after startup work. */
    start: () => {
      nextPoll = clock.now() + pollIntervalMs;
    },
    /** Whether the batch has a wait to poll. */
    pollingNeeded: () =>
      waiting.size > 0 || pendingDecisions.size > 0 || (hasRecordedHeld() && remaining.size > 0),
    /** Whether a waiting issue or a recorded held slot still needs a poll. */
    waitingPollNeeded: () => waiting.size > 0 || (hasRecordedHeld() && remaining.size > 0),
    /** Whether any wait remains after the poll branches. */
    anyWait: () => waiting.size > 0 || pendingDecisions.size > 0 || hasRecordedHeld(),
    /** Waits the rest of the poll interval; an abort ends the wait without an error. */
    waitForNext: (waitSignal) => pollWait(Math.max(0, nextPoll - clock.now()), waitSignal, clock),
    /** Starts the next poll interval at the current clock. */
    advance: () => {
      nextPoll = clock.now() + pollIntervalMs;
    },
    /** Logs the first poll start once. */
    beginPollLog: () => {
      if (pollLogged) return;
      pollLogged = true;
      logInfo(`waiting poll started for issue(s) ${[...waiting, ...pendingDecisions].join(", ")}`);
    },
    /** Logs the poll stop once when a poll started. */
    endPollLog: () => {
      if (pollLogged) logInfo("waiting poll stopped");
    },
  };
}
