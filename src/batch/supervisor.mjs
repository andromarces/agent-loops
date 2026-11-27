// The one foreground supervisor of a batch (ADR 0106 decisions 1, 4, 5, 6, 9, 10, 12). It launches
// one headless child per item, prints progress on stderr, and returns one summary for stdout.
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalPath, samePath } from "../lib/canonical-path.mjs";
import { DEFAULT_READ_TIMEOUT_MS } from "../lib/checks/gh-api.mjs";
import { boundedRunner } from "../lib/checks/bounded-call.mjs";
import { declaredPrFromTranscript, undeclaredPrFromTranscript } from "../lib/gate.mjs";
import { tryStateLock } from "../lib/state-lock.mjs";
import {
  pidAlive,
  processStartTime,
  ownerAlive,
  startTimeCache,
} from "../lib/process-identity.mjs";
import { logError, logWarn } from "../lib/log.mjs";
import { removeEmptyDirectory } from "./audit-store.mjs";
import { cleanupLoop } from "./cleanup.mjs";
import { readGhJson } from "./gh-read.mjs";
import { createOwnerDecisions, readAnswer, readDecision } from "./decisions.mjs";
import {
  preflightItemEligibility,
  readPullRequestClosingNumbers,
  readRepositoryIdentity,
} from "./eligibility.mjs";
import { loopSegment, preparedItems } from "./items.mjs";
import { isIssueLoop, loopEntry, progress, queuedLoop } from "./loop-records.mjs";
import { overlapReportOf } from "./overlap.mjs";
import { notify as defaultNotify } from "./notifier.mjs";
import {
  createLoopWorkTree,
  createPrWorkTree,
  git as gitRead,
  identityEqual,
  pathIdentity,
  planPrWorkTree,
  readWorkTreeGitState,
} from "./git.mjs";
import { reconcileLoop } from "./reconcile.mjs";
import { loopReportFromRead, readLoopReport } from "./report.mjs";
import {
  readTranscript,
  stepsFromRead,
  transcriptAbortFromData,
  transcriptExitFromData,
} from "./steps.mjs";
import { mapInBatches } from "../lib/map-in-batches.mjs";
import {
  batchPaths,
  createBatchStore,
  readLoop,
  readManifest,
  releaseClaim,
  updateLoop,
  updateManifest,
} from "./store.mjs";
import { createWaitPolling, POLL_INTERVAL_MS } from "./wait-polling.mjs";
import { createLoopLauncher, PR_BRANCH_REFUSALS } from "./launch.mjs";

// The batch id stays available here for the tests and the command line.
export { newBatchId } from "./loop-records.mjs";
export { POLL_INTERVAL_MS };

// A needs-owner loop becomes a pending decision and releases its slot
// (adr/0110-release-batch-slots-on-owner-decisions.md decision 1). A waiting loop keeps its
// checkpoint and is re-checked on the poll (adr/0110-release-batch-slots-on-owner-decisions.md
// decision 5).
const TERMINAL = new Set(["succeeded", "skipped", "failed"]);
const INTERRUPT_WAIT_MS = 30_000;
/** The most independent reads in flight at once. */
const READ_BATCH_SIZE = 4;

/** The value a store read returns for `value`, so an absent undefined key stays absent. */
function storedValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Waits `ms`, and an abort ends the wait without an error. An already aborted signal waits too. */
function defaultSleep(ms, signal) {
  if (signal?.aborted) return delay(ms);
  return delay(ms, undefined, { signal }).catch((error) => {
    if (error?.name !== "AbortError") throw error;
  });
}

function skippedLoop(paths, id, item, maxSteps, { reason, evidence }) {
  return {
    ...queuedLoop(paths, id, item, maxSteps),
    status: "skipped",
    skipReason: reason,
    reason: evidence,
  };
}

const terminal = (status) => TERMINAL.has(status);
const loopEnded = (status) => terminal(status) || status === "interrupted";
// The failed line of an aborted loop carries the first line of the abort reason.
const abortDetail = (line) => (line ? `aborted: ${line}` : "aborted");

// The undeclared PR that the runtime resolved for a loop whose worker opened one. A pull request
// item and a `review-only` loop record none.
function undeclaredPrOf(loop, data) {
  if (loop.kind === "pr" || loop.mode === "review-only") return null;
  return undeclaredPrFromTranscript(data);
}

// The declared pull request of one transcript and the undeclared pull request that no declaration
// leaves. An unreadable declaration throws, and the undeclared pull request of an
// unreadable required-check source is read beside it.
function pullRequestOf(loop, transcript) {
  const data = transcript.ok ? transcript.data : null;
  const declaredPr = declaredPrFromTranscript(data) ?? loop.pr;
  return { declaredPr, prUndeclared: declaredPr !== null ? null : undeclaredPrOf(loop, data) };
}

function summaryOf(manifest, loops, skipped = new Map()) {
  const keys = Array.isArray(manifest.items)
    ? manifest.items.map((item) => item.key)
    : manifest.issues;
  return {
    batchId: manifest.id,
    status: manifest.status,
    overlapGroups: manifest.overlapGroups ?? [],
    overlapIncomplete: manifest.overlapIncomplete ?? [],
    loops: keys.map((key) => loopEntry(loops.get(key) ?? skipped.get(key))),
  };
}

function exitCodeOf(manifest, loops) {
  if (manifest.status === "interrupted") return 130;
  if (manifest.status === "paused") return 1;
  return [...loops.values()].some((loop) =>
    ["failed", "needs-owner", "waiting"].includes(loop.status),
  )
    ? 1
    : 0;
}

function isLive(loop) {
  return loop.pid != null;
}

async function ownerStillLive(loop, cache) {
  if (!isLive(loop)) return false;
  return ownerAlive({ pid: loop.pid, startTime: loop.startTime }, cache);
}

/**
 * Whether one issue's pull request closes it, or null when the closing evidence cannot be read.
 * The evidence is the same set that the eligibility check reads: closing references, body keywords
 * on a non-default base, and commit messages. An unreadable read logs one warning and never fails
 * the batch (adr/0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md).
 * @returns {Promise<boolean | null>}
 */
async function pullRequestClosesIssue({ gh, repo, issue, pr, repository }) {
  try {
    const { closed, unreadable, incomplete } = await readPullRequestClosingNumbers({
      gh,
      repo,
      number: pr,
      repository: await repository(),
    });
    if (closed.has(issue)) return true;
    if (unreadable.has(issue)) {
      logWarn(
        `issue ${issue}: the closing-reference read of pull request ${pr} names issue ${issue} with no readable repository`,
      );
      return null;
    }
    if (incomplete) {
      logWarn(
        `issue ${issue}: the closing-reference read of pull request ${pr} reached the 250-commit page`,
      );
      return null;
    }
    return false;
  } catch (err) {
    logWarn(
      `issue ${issue}: the closing-reference read of pull request ${pr} failed: ${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Reads the frozen head, branch, and fork flag of every pull request item before the manifest is
 * written. A read that fails freezes no head, so eligibility later reports it unverified.
 */
async function freezePullRequestItems(items, { gh, repo }) {
  return mapInBatches(items, READ_BATCH_SIZE, async (item) => {
    if (item.kind !== "pr") return item;
    try {
      const view = await readGhJson(
        gh,
        [
          "pr",
          "view",
          String(item.number),
          "--json",
          "state,headRefOid,headRefName,isCrossRepository,title",
        ],
        repo,
      );
      if (typeof view?.headRefOid !== "string") {
        return { ...item, head: null, headRefName: null, foreign: false };
      }
      return {
        ...item,
        head: view.headRefOid,
        headRefName: typeof view.headRefName === "string" ? view.headRefName : null,
        foreign: view.isCrossRepository === true,
        title: typeof view.title === "string" ? view.title : null,
      };
    } catch {
      return { ...item, head: null, headRefName: null, foreign: false };
    }
  });
}

/**
 * Starts or resumes one batch. Returns `{ exitCode, summary }`. Every state write is a checkpoint
 * event; a quiet interval writes nothing.
 */
export async function runBatch(options) {
  const run = {
    stopListening: () => {},
    hasLiveChildren: () => false,
    stopAfterThrow: async () => {},
  };
  let keepListeners = false;
  try {
    return await runBatchWithListeners(options, run);
  } catch (err) {
    // A throw ends live children the same way the first SIGINT does, then rethrows it.
    await run.stopAfterThrow();
    // A live child keeps its listeners so a later interrupt still reaches it.
    keepListeners = run.hasLiveChildren();
    throw err;
  } finally {
    if (!keepListeners) run.stopListening();
  }
}

/**
 * The run itself. `run.stopListening` and `run.hasLiveChildren` are set once the run installs its
 * listeners. The caller keeps both listeners while a live child remains.
 */
async function runBatchWithListeners({ prepared, runsRoot, gh, deps = {} }, run) {
  const paths = batchPaths(runsRoot);
  const id = prepared.id;
  let manifest;
  const loops = new Map();
  let start = true;
  // A resume of a batch that had already reached completed or failed changes no file system
  // state, so it never runs the root removal (issue #2022 review).
  let terminalAtStart = false;
  let interrupted = false;
  let hard = false;
  // A second SIGINT releases the throw cleanup from its wait, as decision 9 requires.
  let releaseHard = () => {};
  const hardStop = new Promise((resolve) => {
    releaseHard = resolve;
  });
  const lockSkipped = new Set();
  let pausedReason = null;
  const notifier = deps.notifier ?? defaultNotify;
  const sendNotification = async (event) => {
    try {
      await notifier(event);
    } catch (err) {
      logWarn(`the notification failed: ${err?.message ?? err}`);
    }
  };

  // One notification per entry into the state where no loop is queued or running and at least one
  // loop waits on an owner merge (adr/0127-notify-when-only-owner-merges-remain.md). A loop that
  // becomes queued or running clears the mark.
  let ownerMergeSent = false;
  const notifyOwnerMergeOnly = async () => {
    if (interrupted || hard) return;
    const records = [...loops.values()];
    if (records.some((loop) => loop.status === "queued" || loop.status === "running")) {
      ownerMergeSent = false;
      return;
    }
    const waitingLoops = records.filter((loop) => loop.status === "waiting");
    if (waitingLoops.length === 0 || ownerMergeSent) return;
    ownerMergeSent = true;
    const described = waitingLoops.map((loop) => {
      const blockers = (loop.blockingIssues ?? []).map((blocker) => {
        const pr = loops.get(blocker)?.pr;
        return Number.isInteger(pr) ? `${blocker} (PR #${pr})` : String(blocker);
      });
      return `issue ${loop.issue} waits for ${blockers.length === 0 ? "an unknown blocker" : blockers.join(", ")}`;
    });
    progress(`owner merges remain: ${described.join("; ")}`);
    await sendNotification({
      kind: "owner-merge",
      title: "Batch waits for owner merges",
      text: `Batch ${id} has no queued or running loop. ${described.join(". ")}.`,
    });
  };

  // The run controller and interruption state exist here, so preflight reads see the run signal.
  const controller = new AbortController();
  const active = new Map();
  const children = new Map();
  const slots = new Set();
  const waiting = new Set();
  const pendingDecisions = new Set();

  const forward = (signal) => {
    for (const child of children.values()) {
      if (signal === "SIGKILL") child.hardKill?.();
      else child.kill?.("SIGINT");
    }
  };
  const interrupt = (reason) => {
    if (interrupted) return;
    interrupted = true;
    progress("interrupted: stopping new launches and forwarding SIGINT");
    controller.abort(reason);
    forward("SIGINT");
  };
  // The first interrupt, from a signal or a throw, arms the hard-kill bound of every live child.
  const beginStop = () => {
    if (interrupted) return;
    interrupt();
    for (const [issue, child] of children) {
      const timer = setTimeout(() => {
        if (children.has(issue)) child.hardKill?.();
      }, INTERRUPT_WAIT_MS);
      timer.unref?.();
    }
  };
  const onSigInt = () => {
    if (!interrupted) beginStop();
    else if (!hard) {
      hard = true;
      progress("second interrupt: ending the child trees now");
      forward("SIGKILL");
      releaseHard();
    }
  };
  const onExternalAbort = () => interrupt(deps.signal.reason);
  const installSignal = deps.installSignal !== false;
  const stopListening = () => {
    if (installSignal) process.removeListener("SIGINT", onSigInt);
    if (deps.signal) deps.signal.removeEventListener("abort", onExternalAbort);
  };
  run.hasLiveChildren = () => children.size > 0;
  run.stopListening = stopListening;
  if (installSignal) process.on("SIGINT", onSigInt);
  if (deps.signal) {
    if (deps.signal.aborted) interrupt(deps.signal.reason);
    else deps.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  gh = boundedRunner(gh, deps.ghTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS, controller.signal);

  // The default work-tree root of a batch, derived from the manifest so a resume names it too.
  const defaultWorkTreeRoot = () =>
    join(dirname(manifest.repo), `${basename(manifest.repo)}-batch-${manifest.id}`);

  // One repository identity read per command, shared by the delivery checks. A failed read is not
  // cached, so the next succeeded loop tries again.
  let repositoryRead = null;
  const repositoryIdentity = () => {
    if (repositoryRead === null) {
      repositoryRead = readRepositoryIdentity({ gh, repo: manifest.repo }).catch((err) => {
        repositoryRead = null;
        throw err;
      });
    }
    return repositoryRead;
  };

  // Removes the batch root only when the batch ran on the default root and it is empty. The
  // recorded path and the derived default are compared as text, without resolving a link: a
  // canonical comparison would treat a link from the default path to a user root as proof that
  // the batch used the default. The lstat guard reads the derived path itself, so a link there
  // is never removed or followed. A root the user passed with --work-tree-root is not the
  // derived default and stays.
  const removeDefaultWorkTreeRoot = async () => {
    if (typeof manifest.repo !== "string" || typeof manifest.workTreeRoot !== "string") return;
    const expected = defaultWorkTreeRoot();
    if (!samePath(resolve(manifest.workTreeRoot), resolve(expected))) return;
    const removal = await removeEmptyDirectory(expected);
    if (removal.removed) {
      progress(`batch ${manifest.id}: removed the empty work-tree root`);
    } else if (removal.reason !== null) {
      logWarn(`batch ${manifest.id}: kept the work-tree root: ${removal.reason}`);
    }
  };

  // Every path that ends the batch uses this finalization.
  // A resume after an answer reports the same status, summary, exit code, and one completion
  // notification.
  const finalizeBatch = async () => {
    let status;
    if (interrupted) status = "interrupted";
    else if (pausedReason !== null) status = "paused";
    else if (
      lockSkipped.size > 0 ||
      [...loops.values()].some((loop) => loop.status === "running")
    ) {
      status = "paused";
      pausedReason ??= "a loop is owned by another resume";
    } else if (
      [...loops.values()].some((loop) => ["waiting", "needs-owner"].includes(loop.status))
    ) {
      status = "waiting";
    } else if ([...loops.values()].some((loop) => loop.status === "failed")) {
      status = "failed";
    } else status = "completed";
    // A completed or failed batch reports the pull requests of its succeeded loops that change a
    // common file (adr/0176-report-batch-pull-requests-that-change-the-same-files.md). The read
    // runs before the completion is recorded, so a stop during the read keeps an interrupted batch
    // and its exit 130, and the next resume computes the report. A failed or incomplete file-list
    // read logs a warning and never fails the batch. A resume of a batch that had already ended
    // keeps the stored report.
    let cancelled = interrupted;
    let overlap = null;
    if ((status === "completed" || status === "failed") && !terminalAtStart) {
      overlap = await overlapReportOf({ loops: [...loops.values()], gh, repo: manifest.repo });
      if (interrupted) {
        cancelled = true;
        status = "interrupted";
        overlap = null;
      }
    }
    const updated = await updateManifestReturning(runsRoot, id, (value) => {
      // A finalizer never moves a batch that another process recorded terminal, so a cancel of
      // this command cannot undo a completion that already stored its report. The checks run under
      // the batch lock, on the value the write would replace.
      const recorded = value.status === "completed" || value.status === "failed";
      if (recorded && value.status !== status) return undefined;
      // Only the first finalizer saves a report. A stored report, a failed or slower read included,
      // is never replaced.
      return {
        ...value,
        status,
        ...(pausedReason === null ? {} : { pauseReason: pausedReason }),
        ...(overlap === null || value.overlapGroups !== undefined
          ? {}
          : { overlapGroups: overlap.groups, overlapIncomplete: overlap.incomplete }),
      };
    });
    manifest = updated.manifest;
    const complete = status === "completed" || status === "failed";
    if (complete && manifest.completionNotified !== true) {
      const counts = { succeeded: 0, failed: 0, skipped: 0 };
      for (const loop of loops.values()) {
        if (loop.status in counts) counts[loop.status] += 1;
      }
      await sendNotification({
        kind: "batch-completed",
        title: "Batch complete",
        text: `Batch ${id} finished with status ${status}. Succeeded: ${counts.succeeded}. Failed: ${counts.failed}. Skipped: ${counts.skipped}.`,
      });
      manifest = (
        await updateManifestReturning(runsRoot, id, (value) => ({
          ...value,
          completionNotified: true,
        }))
      ).manifest;
    }
    // A batch that was already completed or failed when a resume started is a no-op: its removal
    // already ran or never applied, and a resume must change no file system state.
    if (complete && !terminalAtStart) await removeDefaultWorkTreeRoot();
    return {
      // A cancel keeps main's interrupt result, whatever another process stored.
      exitCode: cancelled ? 130 : exitCodeOf(manifest, loops),
      summary: summaryOf(
        manifest,
        loops,
        new Map((manifest.skipped ?? []).map((loop) => [loop.key, loop])),
      ),
    };
  };

  // A throw with no live child writes nothing, as before. Otherwise it stops every live child,
  // waits for its finish path, and marks the batch interrupted. A cleanup failure is logged and
  // never replaces the original error.
  run.stopAfterThrow = async () => {
    if (children.size === 0) return;
    try {
      beginStop();
      const pending = [];
      for (const [issue, child] of children) {
        const registered = active.get(issue);
        if (registered !== undefined) {
          pending.push(registered);
          continue;
        }
        const settling = settleChild(issue, child, () => true);
        // The handler logs a failure that arrives before or after a second SIGINT ends the wait.
        settling.catch((err) => logError(`the child cleanup failed: ${err?.message ?? err}`));
        pending.push(settling);
      }
      await Promise.race([Promise.allSettled(pending), hardStop.then(() => null)]);
      await finalizeBatch();
    } catch (err) {
      logError(`the throw cleanup failed: ${err?.message ?? err}`);
    }
  };

  if (prepared.resume) {
    manifest = await readManifest(runsRoot, id);
    if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
    start = false;
    terminalAtStart = manifest.status === "completed" || manifest.status === "failed";
    const itemsByKey = new Map((manifest.items ?? []).map((item) => [item.key, item]));
    for (const issue of manifest.issues) {
      let loop = await readLoop(runsRoot, id, issue);
      if (loop === null && itemsByKey.has(issue)) {
        loop = queuedLoop(paths, id, itemsByKey.get(issue), prepared.maxSteps);
      }
      loops.set(issue, loop);
    }
    const pending = manifest.issues.some((issue) => {
      const loop = loops.get(issue);
      return !terminal(loop.status) || (loop.status === "succeeded" && loop.cleanup === null);
    });
    if (!pending) {
      return finalizeBatch();
    }
    const actionable = [];
    for (const issue of manifest.issues) {
      const loop = loops.get(issue);
      if (loop.status === "needs-owner") {
        if (typeof loop.decision !== "string") {
          actionable.push(issue);
          continue;
        }
        const decision = await readDecision(runsRoot, id, loop.decision);
        if (decision === null || !decision.ok) continue;
        const options = decision.decision.options.map((option) => option.key);
        const answer = await readAnswer(runsRoot, id, loop.decision, options, loop.issue);
        if (answer !== null) actionable.push(issue);
      } else if (loop.status === "waiting") {
        actionable.push(issue);
      } else if (!terminal(loop.status) || (loop.status === "succeeded" && loop.cleanup === null)) {
        actionable.push(issue);
      }
    }
    if (actionable.length === 0) {
      for (const issue of manifest.issues) {
        const loop = loops.get(issue);
        if (loop.status !== "needs-owner") continue;
        const lockFile = join(paths.batchDir(id), "loops", `${loopSegment(issue)}.resume.lock`);
        const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
        if (release === null) lockSkipped.add(issue);
        else await release();
      }
      if (lockSkipped.size === 0) {
        if (manifest.status !== "waiting") {
          manifest = (
            await updateManifestReturning(runsRoot, id, (value) => ({
              ...value,
              status: "waiting",
              pauseReason: null,
            }))
          ).manifest;
        }
        return finalizeBatch();
      }
    }
    if (manifest.status !== "running") {
      manifest = (
        await updateManifestReturning(runsRoot, id, (value) => ({
          ...value,
          status: "running",
          pauseReason: null,
        }))
      ).manifest;
    }
  } else {
    const freezeItems = deps.freezeItems ?? freezePullRequestItems;
    const frozenItems = await freezeItems(preparedItems(prepared), {
      gh,
      repo: prepared.repo,
    });
    const items = [];
    const skipped = [];
    const startPlanTree = deps.planPrWorkTree ?? planPrWorkTree;
    for (const item of frozenItems) {
      if (interrupted) break;
      const eligibility = await preflightItemEligibility({
        item,
        gh,
        repo: prepared.repo,
        batchId: id,
      });
      if (!eligibility.ok) {
        skipped.push(skippedLoop(paths, id, item, prepared.maxSteps, eligibility));
        continue;
      }
      if (item.kind === "pr") {
        try {
          await startPlanTree({
            repo: prepared.repo,
            branch: item.headRefName ?? `pr-${item.number}`,
            head: item.head,
            number: item.number,
          });
        } catch (err) {
          if (!PR_BRANCH_REFUSALS.has(err?.code)) {
            throw err;
          }
          skipped.push(
            skippedLoop(paths, id, item, prepared.maxSteps, {
              reason: err.code,
              evidence: err.message,
            }),
          );
          continue;
        }
      }
      items.push(item);
    }
    if (interrupted) {
      progress(`batch ${id}: interrupted before any state write`);
      return {
        exitCode: 130,
        summary: {
          batchId: id,
          status: "interrupted",
          loops: skipped.map((loop) => loopEntry(loop)),
        },
      };
    }
    if (items.length === 0) {
      progress(`batch ${id}: every item was refused before any state write`);
      return {
        exitCode: 0,
        summary: {
          batchId: id,
          status: "completed",
          loops: skipped.map((loop) => loopEntry(loop)),
        },
      };
    }
    const keys = items.map((item) => item.key);
    manifest = {
      id,
      repo: prepared.repo,
      repoKey: prepared.repoKey,
      createdAt: new Date().toISOString(),
      base: prepared.base,
      workTreeRoot: prepared.workTreeRoot,
      issues: keys,
      items: frozenItems,
      skipped,
      status: "running",
      completionNotified: false,
      settings: {
        loops: prepared.loops,
        maxSteps: prepared.maxSteps,
        taskTemplate: prepared.taskTemplate,
        requireSpecification: prepared.requireSpecification === true,
        setupCmd: prepared.setupCmd,
        setupTimeout: prepared.setupTimeout,
        testCmd: prepared.testCmd,
        testCmdTimeout: prepared.testCmdTimeout,
        timeout: prepared.timeout,
        reviewerSandbox: prepared.reviewerSandbox,
        roles: prepared.roles,
      },
    };
    for (const item of items) loops.set(item.key, queuedLoop(paths, id, item, prepared.maxSteps));
    const storedLoops = [...loops.values()].filter((loop) => loop.kind !== "pr");
    await createBatchStore(runsRoot, manifest, storedLoops);
    progress(`batch ${id} started (${items.length} item(s), ${prepared.loops} loop(s))`);
  }

  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const clock = { now: deps.now ?? (() => performance.now()), sleep: deps.sleep ?? defaultSleep };

  // A loop end reads its transcript once for the report and stores the report in the same checkpoint
  // write as the status change. The report adds no store write. A caller that already read the
  // transcript passes the read result in `transcript`, so the end adds no second read.
  const changeLoop = async (issue, patch, { transcript } = {}) => {
    let nextPatch = patch;
    if (patch?.status !== undefined && loopEnded(patch.status) && patch.report === undefined) {
      const current = loops.get(issue) ?? (await readLoop(runsRoot, id, issue));
      const options = {
        attempts: current.attempts,
        reviewOnly: current.mode === "review-only",
      };
      nextPatch = {
        ...patch,
        report:
          transcript === undefined
            ? await readLoopReport(current.transcript, options)
            : loopReportFromRead(transcript, options),
      };
    }
    let next;
    const changed = await updateLoop(
      runsRoot,
      id,
      issue,
      (current) => {
        next = { ...current, ...nextPatch };
        return next;
      },
      { initial: loops.get(issue) ?? null },
    );
    loops.set(issue, storedValue(next));
    return changed;
  };

  const createWorkTree = deps.createWorkTree ?? createLoopWorkTree;
  const createPullRequestWorkTree =
    deps.createPrWorkTree ?? deps.createWorkTree ?? createPrWorkTree;
  const planTree = deps.planPrWorkTree ?? planPrWorkTree;
  const reconcile = deps.reconcileLoop ?? reconcileLoop;
  const cleanupWorkTree = deps.cleanupLoop ?? cleanupLoop;
  const probeStartTime = deps.processStartTime ?? processStartTime;
  const verifyRecordedWorkTree = async (loop) => {
    const workTree = loop.workTree;
    if (!workTree?.path) return "the recorded work tree is missing";
    const identity = await pathIdentity(workTree.path);
    if (identity === null || !identityEqual(identity, workTree)) {
      return "the recorded work tree identity changed";
    }
    if ((await canonicalPath(workTree.path)) !== workTree.canonicalPath) {
      return "the recorded work tree identity changed";
    }
    const reads = await readWorkTreeGitState(workTree.path, { runner: gitRead });
    if (workTree.detached === true) {
      return reads.head.exitCode === 0 && reads.head.stdout === workTree.head
        ? null
        : "the recorded head is not checked out";
    }
    return reads.branch.exitCode === 0 && reads.branch.stdout === workTree.branch
      ? null
      : "the recorded branch is not checked out";
  };

  const verifyWorkTree = deps.verifyWorkTree ?? verifyRecordedWorkTree;

  const { markNeedsOwner, applyDecisionAnswer } = createOwnerDecisions({
    runsRoot,
    batchId: id,
    repoKey: prepared.repoKey,
    pending: pendingDecisions,
    changeLoop,
    notify: sendNotification,
    loopOf: (issue) => loops.get(issue),
  });

  const markPrHeadUnresolved = async (
    issue,
    loop,
    { pr, prUndeclared, stepsUsed, remainingSteps, transcript },
  ) => {
    const options = {
      attempts: loop.attempts,
      reviewOnly: loop.mode === "review-only",
    };
    const report =
      transcript === undefined
        ? await readLoopReport(loop.transcript, options)
        : loopReportFromRead(transcript, options);
    const recorded = pr ?? prUndeclared ?? null;
    return markNeedsOwner(issue, "pr-head-unresolved", {
      evidence:
        recorded === null ? "the transcript records no pull request" : `pull request ${recorded}`,
      extra: {
        pr,
        prUndeclared: prUndeclared ?? null,
        stepsUsed,
        remainingSteps,
        pid: null,
        startTime: null,
        report,
      },
    });
  };

  const finishChild = async (issue, exitCode, { interrupted: wasInterrupted }) => {
    let loop = await readLoop(runsRoot, id, issue);
    const transcript = await readLoopTranscript(loop.transcript);
    const steps = stepsFromRead(transcript, {
      checkpointSteps: loop.stepsUsed,
      attempts: loop.attempts,
    });
    const stepsUsed = steps.ok ? steps.steps : loop.stepsUsed;
    const remainingSteps = Math.max(0, prepared.maxSteps - stepsUsed);
    let declared = { declaredPr: loop.pr, prUndeclared: null };
    try {
      declared = pullRequestOf(loop, transcript);
    } catch (err) {
      await markNeedsOwner(
        issue,
        `the transcript declares an unreadable pull request: ${err.message}`,
        {
          evidence: err.message,
          extra: {
            stepsUsed,
            remainingSteps,
            pid: null,
            startTime: null,
            prUndeclared: declared.prUndeclared,
          },
        },
      );
      return;
    }
    const { declaredPr, prUndeclared } = declared;
    const common = { stepsUsed, remainingSteps, pid: null, startTime: null, prUndeclared };

    if (wasInterrupted || exitCode === 130) {
      await changeLoop(
        issue,
        { ...common, status: "interrupted", reason: "interrupted", pr: declaredPr },
        { transcript },
      );
      progress(`issue ${issue}: interrupted`);
      return;
    }
    if (exitCode === 0) {
      const cleanup = await finishSuccess(issue, loop, {
        stepsUsed,
        remainingSteps,
        pr: declaredPr,
        prUndeclared,
        transcript,
      });
      progress(
        `issue ${issue}: succeeded${cleanup.removed ? " (work tree removed)" : ` (work tree kept: ${cleanup.reason})`}`,
      );
      return;
    }
    if (exitCode === 4) {
      await markPrHeadUnresolved(issue, loop, { ...common, pr: declaredPr, transcript });
      progress(`issue ${issue}: needs-owner (pr-head-unresolved)`);
      return;
    }
    const abort = transcriptAbortFromData(transcript.ok ? transcript.data : null, exitCode ?? null);
    if (abort) {
      await finishFailure(issue, loop, "aborted", {
        stepsUsed,
        remainingSteps,
        transcript,
        detail: abortDetail(abort.reason),
        pr: declaredPr,
        prUndeclared,
      });
      return;
    }
    await finishFailure(issue, loop, `exit-${exitCode ?? "unknown"}`, {
      stepsUsed,
      remainingSteps,
      transcript,
      detail: `exit ${exitCode ?? "unknown"}`,
      pr: declaredPr,
      prUndeclared,
    });
  };

  // Waits for one spawned child, releases its slot, and writes its checkpoint. The interruption
  // flag is read after the child settles, so a stop that arrives during the wait is recorded.
  const settleChild = async (issue, child, interruptedNow) => {
    const { exitCode } = await child.done;
    child.close?.();
    children.delete(issue);
    slots.delete(issue);
    await finishChild(issue, exitCode, { interrupted: interruptedNow() });
    await notifyOwnerMergeOnly();
  };

  const readLoopTranscript = (file) => readTranscript(file, deps.readTranscript);

  // The undeclared pull request that a finish writes. An explicit null clears a stale record of an
  // earlier attempt; an omitted value keeps the stored one (ADR 0131).
  const recordedUndeclared = (prUndeclared, loop) =>
    prUndeclared === undefined ? (loop.prUndeclared ?? null) : prUndeclared;

  // Writes the success checkpoint, removes the loop's work tree, and releases its claim. Returns
  // the cleanup result so the caller can report it.
  const finishSuccess = async (
    issue,
    loop,
    { stepsUsed, remainingSteps, pr, prUndeclared, transcript },
  ) => {
    const recordedPr = pr ?? loop.pr;
    // The success checkpoint carries its report and the closing fact in one write, so the partial
    // marker never depends on a later read
    // (adr/0178-mark-a-succeeded-loop-that-does-not-deliver-its-item.md). The delivery check reads
    // only the final attempt's pull request, never a value that an earlier attempt stored.
    const options = { attempts: loop.attempts, reviewOnly: loop.mode === "review-only" };
    const report =
      transcript === undefined
        ? await readLoopReport(loop.transcript, options)
        : loopReportFromRead(transcript, options);
    const finalPr = pr ?? prUndeclared ?? null;
    const closesIssue = isIssueLoop(loop)
      ? finalPr === null
        ? null
        : await pullRequestClosesIssue({
            gh,
            repo: manifest.repo,
            issue,
            pr: finalPr,
            repository: repositoryIdentity,
          })
      : undefined;
    await changeLoop(
      issue,
      {
        status: "succeeded",
        reason: null,
        skipReason: null,
        stepsUsed,
        remainingSteps,
        pr: recordedPr,
        prUndeclared: recordedPr == null ? recordedUndeclared(prUndeclared, loop) : null,
        pid: null,
        startTime: null,
        report,
        ...(closesIssue === undefined ? {} : { pullRequestClosesIssue: closesIssue }),
      },
      { transcript },
    );
    const updated = loops.get(issue);
    const cleanup = await cleanupWorkTree({ manifest, loop: updated, runsRoot, gh }).catch(
      (err) => ({
        removed: false,
        reason: err.message,
      }),
    );
    await changeLoop(issue, { cleanup });
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
    return cleanup;
  };

  // Writes the failed checkpoint and releases the claim. `pr` is left as stored unless `pr` names it.
  const finishFailure = async (
    issue,
    loop,
    reason,
    { stepsUsed, remainingSteps, transcript, detail = null, pr, prUndeclared },
  ) => {
    logError(`issue ${issue}: failed (${detail ?? reason})`);
    await changeLoop(
      issue,
      {
        status: "failed",
        reason,
        stepsUsed,
        remainingSteps,
        ...(pr === undefined ? {} : { pr }),
        prUndeclared: recordedUndeclared(prUndeclared, loop),
        pid: null,
        startTime: null,
      },
      { transcript },
    );
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
  };

  // A held resume lock means another resume owns the loop. The sentinel keeps that apart from a
  // null result of `fn`.
  const LOCK_SKIPPED = Symbol("resume lock skipped");
  const withLoopLock = async (issue, fn) => {
    const lockFile = join(paths.batchDir(id), "loops", `${loopSegment(issue)}.resume.lock`);
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    if (release === null) {
      lockSkipped.add(issue);
      return LOCK_SKIPPED;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  const withLoopOwnership = async (issue, fn) => {
    if ((await withLoopLock(issue, fn)) === LOCK_SKIPPED) {
      progress(`issue ${issue}: another resume owns the loop`);
    }
  };

  // A pending-decision refresh takes the loop lock so a held lock reports paused.
  // A null result means another resume owns the loop and the caller keeps it pending.
  const withLoopResult = async (issue, fn) => {
    const result = await withLoopLock(issue, fn);
    return result === LOCK_SKIPPED ? null : result;
  };

  /**
   * Continues one loop from its transcript. It reads the transcript once. It then reads the steps,
   * applies the exhaustion check, reconciles GitHub, and launches with --continue-from and the
   * recorded pull request.
   */
  const continueLoop = async (issue, initial) => {
    let loop = initial;
    const transcript = await readLoopTranscript(loop.transcript);
    if ((!transcript.ok || transcript.data === null) && loop.attempts > 0) {
      await markNeedsOwner(issue, "unverified-steps", {
        evidence: "the transcript is missing",
        extra: { prUndeclared: loop.prUndeclared ?? null },
      });
      return;
    }
    let declared;
    try {
      declared = pullRequestOf(loop, transcript);
    } catch (err) {
      await markNeedsOwner(
        issue,
        `the transcript declares an unreadable pull request: ${err.message}`,
        {
          evidence: err.message,
          extra: { prUndeclared: loop.prUndeclared ?? null },
        },
      );
      return;
    }
    loop = { ...loop, pr: declared.declaredPr, prUndeclared: declared.prUndeclared };

    const recordedExit = transcript.ok
      ? transcriptExitFromData(transcript.data)
      : { ok: false, reason: transcript.reason };
    const steps = stepsFromRead(transcript, {
      checkpointSteps: loop.stepsUsed,
      attempts: loop.attempts,
    });
    const stepsUsed = steps.ok ? steps.steps : loop.stepsUsed;
    const remainingSteps = Math.max(0, prepared.maxSteps - stepsUsed);
    if (recordedExit.ok && recordedExit.proven && recordedExit.exitCode === 0) {
      await finishSuccess(issue, loop, {
        stepsUsed,
        remainingSteps,
        pr: declared.declaredPr,
        prUndeclared: declared.prUndeclared,
        transcript,
      });
      return;
    }
    if (
      recordedExit.ok &&
      recordedExit.proven &&
      recordedExit.exitCode === 4 &&
      loop.decisionAnswer !== "resume"
    ) {
      await markPrHeadUnresolved(issue, loop, {
        pr: loop.pr,
        prUndeclared: loop.prUndeclared,
        stepsUsed,
        remainingSteps,
        transcript,
      });
      return;
    }
    if (recordedExit.ok && recordedExit.proven && [1, 2].includes(recordedExit.exitCode)) {
      const abort =
        recordedExit.exitCode === 1
          ? transcriptAbortFromData(transcript.ok ? transcript.data : null, recordedExit.exitCode)
          : null;
      if (abort) {
        await finishFailure(issue, loop, "aborted", {
          stepsUsed,
          remainingSteps,
          transcript,
          detail: abortDetail(abort.reason),
        });
        return;
      }
      await finishFailure(issue, loop, `exit-${recordedExit.exitCode}`, {
        stepsUsed,
        remainingSteps,
        transcript,
      });
      return;
    }
    if (!steps.ok) {
      await markNeedsOwner(issue, "unverified-steps", {
        evidence: steps.reason ?? "the step count is unreadable",
        extra: { stepsUsed, remainingSteps, prUndeclared: loop.prUndeclared ?? null },
      });
      return;
    }
    if (remainingSteps <= 0) {
      await finishFailure(issue, loop, "step-budget-exhausted", {
        stepsUsed,
        remainingSteps: 0,
        transcript,
      });
      return;
    }
    const decision = await reconcile({
      loop,
      repo: prepared.repo,
      base: prepared.base,
      gh,
      deps,
      transcript: transcript.ok ? transcript.data : null,
    });
    if (decision.status === "succeeded") {
      await finishSuccess(issue, loop, {
        stepsUsed,
        remainingSteps,
        pr: decision.pr ?? declared.declaredPr,
        prUndeclared: decision.pr == null ? declared.prUndeclared : null,
        transcript,
      });
      return;
    }
    if (decision.status === "needs-owner") {
      await markNeedsOwner(issue, decision.reason, {
        evidence: decision.reason,
        extra: { stepsUsed, remainingSteps, prUndeclared: loop.prUndeclared ?? null },
      });
      return;
    }
    const recordedPr = decision.pr ?? loop.pr;
    await changeLoop(issue, {
      stepsUsed,
      remainingSteps,
      pr: recordedPr,
      prUndeclared: recordedPr == null ? (loop.prUndeclared ?? null) : null,
      pid: null,
      startTime: null,
    });
    await launcher.launchIssue(issue, {
      recovery: { continueFrom: loop.transcript, pr: decision.pr ?? loop.pr },
    });
  };

  const launcher = createLoopLauncher({
    runsRoot,
    batchId: id,
    paths,
    prepared,
    deps,
    gh,
    loops,
    slots,
    waiting,
    children,
    active,
    signal: controller.signal,
    isStopped: () => interrupted || hard,
    changeLoop,
    notify: sendNotification,
    planTree,
    createWorkTree,
    createPullRequestWorkTree,
    verifyWorkTree,
    reconcile,
    markNeedsOwner,
    finishSuccess,
    continueLoop,
    settleChild,
    setPausedReason: (reason) => {
      pausedReason = reason;
    },
  });

  const recover = async (issue, initial) => {
    let loop = initial;
    if (isLive(loop)) {
      // A recorded live PID is never restarted. Without a readable identity the loop needs its
      // owner instead of waiting forever (adr/0106-foreground-batch-scheduling.md decision 10).
      const current = await probeStartTime(loop.pid);
      if (pidAlive(loop.pid) && (loop.startTime == null || current === null)) {
        // Keep the recorded PID and stamp: a later resume must re-check it before any launch.
        await markNeedsOwner(issue, "unverified-process-identity", {
          evidence: "the process start stamp cannot be read",
          extra: { prUndeclared: loop.prUndeclared ?? null },
        });
        return;
      }
      // One cache per wait, so a live owner's start time is probed once per cache age window
      // and not on every 250 ms poll. The first check above stays fresh.
      const cache = startTimeCache({ probe: probeStartTime });
      while (await ownerStillLive(loop, cache)) {
        if (interrupted || hard) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      slots.delete(issue);
    }
    if (loop.status === "needs-owner") {
      const applied = await applyDecisionAnswer(issue, loop);
      if (applied.kind !== "resume") return;
      loop = applied.loop;
    }
    await continueLoop(issue, loop);
  };

  // Fill the loop slots from the frozen set in order. A waiting issue and a pending decision
  // are polled outside the queue.
  const remaining = new Set();
  for (const issue of manifest.issues) {
    const loop = loops.get(issue);
    if (loop.status === "waiting") waiting.add(issue);
    else if (loop.status === "needs-owner") pendingDecisions.add(issue);
    else if (!terminal(loop.status) || (loop.status === "succeeded" && loop.cleanup === null)) {
      remaining.add(issue);
    }
  }
  const nextIssue = () => {
    for (const issue of manifest.issues) if (remaining.has(issue)) return issue;
    return null;
  };
  const waits = createWaitPolling({
    runsRoot,
    batchId: id,
    repo: prepared.repo,
    gh,
    signal: controller.signal,
    issues: () => manifest.issues,
    waiting,
    pendingDecisions,
    slots,
    remaining,
    loops,
    active,
    clock,
    pollIntervalMs,
    changeLoop,
    notify: sendNotification,
    progress,
    applyDecisionAnswer,
    withLoopResult,
    isLive,
    isStopped: () => interrupted || hard,
  });

  for (const issue of manifest.issues) {
    const loop = loops.get(issue);
    if (loop !== null && isLive(loop)) {
      // This check and the pre-wait identity check read the injectable probe. A fresh cache
      // keeps this read fresh.
      const cache = startTimeCache({ probe: probeStartTime });
      if (await ownerAlive({ pid: loop.pid, startTime: loop.startTime }, cache)) slots.add(issue);
    }
  }
  await waits.refreshPendingDecisions();
  await notifyOwnerMergeOnly();
  // An issue that already holds a slot is taken for its own recovery or launch. A new issue
  // enters only while a slot is free.
  const canTake = () => {
    const issue = nextIssue();
    if (issue === null) return false;
    return slots.has(issue) || slots.size < prepared.loops;
  };
  waits.start();
  for (;;) {
    while (!interrupted && !hard && pausedReason === null && canTake() && remaining.size > 0) {
      const issue = nextIssue();
      remaining.delete(issue);
      const runOne = async () => {
        let current = await readLoop(runsRoot, id, issue);
        if (current === null) {
          const item = (manifest.items ?? []).find((entry) => entry.key === issue);
          if (item === undefined) return;
          current = queuedLoop(paths, id, item, prepared.maxSteps);
        }
        loops.set(issue, current);
        if (!start && current.status === "succeeded" && current.cleanup === null) {
          const cleanup = await cleanupWorkTree({ manifest, loop: current, runsRoot, gh }).catch(
            (err) => ({ removed: false, reason: err.message }),
          );
          await changeLoop(issue, { cleanup });
          await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
          return;
        }
        if (terminal(current.status)) return;
        if (current.status === "needs-owner") {
          pendingDecisions.add(issue);
          return;
        }
        const appliedAnswer = current.decisionAnswer != null;
        if (!start) {
          // A resume reconciles one recovered loop before it launches, so it never restarts
          // blindly. A counted attempt or a recorded answer never takes the fresh-launch path.
          const hasTranscript =
            current.status !== "queued" ||
            (await stat(current.transcript).then(
              () => true,
              () => false,
            ));
          if (hasTranscript || current.attempts > 0 || appliedAnswer) {
            await recover(issue, current);
            return;
          }
        }
        const launch = async () => {
          try {
            await launcher.launchIssue(issue);
          } catch (err) {
            if (!err?.batchWide) throw err;
          }
        };
        if (start && appliedAnswer) {
          await withLoopOwnership(issue, launch);
          return;
        }
        await launch();
      };
      if (start) await runOne();
      else await withLoopOwnership(issue, runOne);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await notifyOwnerMergeOnly();
    if (hard || interrupted) break;
    if (pausedReason !== null && active.size === 0) break;
    if (waits.pollingNeeded()) waits.beginPollLog();
    if (active.size > 0) {
      const racers = [...active.values()];
      let pollElapsed = false;
      let pollController = null;
      if (waits.pollingNeeded()) {
        pollController = new AbortController();
        const pollSignal = AbortSignal.any([controller.signal, pollController.signal]);
        racers.push(
          waits.waitForNext(pollSignal).then(() => {
            pollElapsed = true;
          }),
        );
      }
      await Promise.race(racers);
      pollController?.abort();
      if (interrupted || hard) break;
      if (pollElapsed) {
        waits.advance();
        await waits.poll();
        await notifyOwnerMergeOnly();
      }
      continue;
    }
    if (pausedReason !== null) break;
    if (!waits.anyWait()) break;
    if (waits.waitingPollNeeded()) {
      await waits.waitForNext(controller.signal);
      if (interrupted || hard) break;
      waits.advance();
      await waits.poll();
      await notifyOwnerMergeOnly();
      continue;
    }
    // Only pending decisions remain. Apply a live answer that already arrived, then stop.
    await waits.poll({ waiting: false });
    if (remaining.size > 0) continue;
    break;
  }
  waits.endPollLog();
  // A resume runs its recovered loops one at a time; this drains any that the pass left live.
  while (active.size > 0 && !hard) await Promise.race(active.values());

  return finalizeBatch();
}

async function updateManifestReturning(runsRoot, id, updater) {
  let next;
  const changed = await updateManifest(runsRoot, id, async (value) => {
    next = await updater(value);
    return next;
  });
  const manifest = next == null ? await readManifest(runsRoot, id) : storedValue(next);
  return { manifest, changed };
}
