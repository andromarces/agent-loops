// The one foreground supervisor of a batch (ADR 0106 decisions 1, 4, 5, 6, 9, 10, 12). It launches
// one headless child per issue, prints progress on stderr, and returns one summary for stdout.
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { declaredPrFromTranscript } from "../lib/gate.mjs";
import { endSubprocessTree, killTreeOnExit } from "../lib/exec-tree.mjs";
import { tryStateLock } from "../lib/state-lock.mjs";
import { pidAlive, processStartTime, ownerAlive } from "../lib/process-identity.mjs";
import { execBounded } from "../lib/exec.mjs";
import { logError, logInfo, logWarn } from "../lib/log.mjs";
import { renderTask, DEFAULT_TASK_TEMPLATE, DEFAULT_PR_TASK_TEMPLATE } from "./args.mjs";
import { cleanupLoop } from "./cleanup.mjs";
import {
  ABANDON_REASON,
  DECISION_OPTIONS,
  SKIP_REASON,
  createDecision,
  newDecisionId,
  optionsForReason,
  readAnswer,
  readDecision,
  recommendedOf,
} from "./decisions.mjs";
import {
  checkItemEligibility,
  preflightItemEligibility,
  readOpenPrClosures,
} from "./eligibility.mjs";
import { defaultMode, loopSegment, preparedItems } from "./items.mjs";
import { notify as defaultNotify } from "./notifier.mjs";
import {
  createLoopWorkTree,
  createPrWorkTree,
  git as gitRead,
  identityEqual,
  pathIdentity,
  planPrWorkTree,
} from "./git.mjs";
import { reconcileLoop } from "./reconcile.mjs";
import { missingLoopReport, readLoopReport } from "./report.mjs";
import { readStepsUsed, readTranscriptExit } from "./steps.mjs";
import {
  acquireClaim,
  batchPaths,
  createBatchStore,
  listBatches,
  readClaim,
  readLoop,
  readManifest,
  releaseClaim,
  updateLoop,
  updateManifest,
} from "./store.mjs";

// A needs-owner loop becomes a pending decision and releases its slot
// (adr/0110-release-batch-slots-on-owner-decisions.md decision 1). A waiting loop keeps its
// checkpoint and is re-checked on the poll (adr/0110-release-batch-slots-on-owner-decisions.md
// decision 5).
const TERMINAL = new Set(["succeeded", "skipped", "failed"]);
const INTERRUPT_WAIT_MS = 30_000;
/** The wait between two re-checks of a blocked issue (adr/0110-release-batch-slots-on-owner-decisions.md decision 5). */
export const POLL_INTERVAL_MS = 15_000;
/** The bound on one poll read of the wait state. */
export const POLL_READ_TIMEOUT_MS = 60_000;

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Waits one poll interval on the monotonic clock. An abort ends the wait at once without an error,
 * so the caller keeps its own cancel identity. Tests inject `now` and `sleep`.
 */
export async function pollWait(
  ms,
  signal,
  { now = () => performance.now(), sleep = defaultSleep } = {},
) {
  const deadline = now() + ms;
  while (!signal?.aborted) {
    const remaining = deadline - now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, 1000), signal);
  }
}

let ownStamp;
function ownStartTimeOnce() {
  ownStamp ??= processStartTime(process.pid);
  return ownStamp;
}

/** Generates a batch id that is safe as a directory and a branch segment. */
export function newBatchId(now = new Date()) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/** A progress line on stderr, because stdout carries one JSON summary. */
export function progress(message) {
  process.stderr.write(`[agent-loop] batch: ${message}\n`);
}

function queuedLoop(paths, id, item, maxSteps) {
  const key = item.key;
  return {
    issue: key,
    key,
    kind: item.kind,
    number: item.number ?? null,
    text: item.text ?? null,
    mode: item.mode ?? defaultMode(item.kind),
    head: item.head ?? null,
    headRefName: item.headRefName ?? null,
    foreign: item.foreign === true,
    prTitle: item.title ?? null,
    taskOverride: item.task ?? null,
    status: "queued",
    skipReason: null,
    reason: null,
    attempts: 0,
    branch: item.kind === "pr" ? (item.headRefName ?? `pr-${item.number}`) : `batch/${id}/${key}`,
    workTree: null,
    transcript: paths.transcript(id, key),
    log: null,
    pid: null,
    startTime: null,
    stepsUsed: 0,
    remainingSteps: maxSteps,
    pr: item.kind === "pr" ? item.number : null,
    cleanup: null,
    decision: null,
    decisionAnswer: null,
    blockingIssues: [],
    report: null,
  };
}

function skippedLoop(paths, id, item, maxSteps, { reason, evidence }) {
  return {
    ...queuedLoop(paths, id, item, maxSteps),
    status: "skipped",
    skipReason: reason,
    reason: evidence,
  };
}

/** The argv of one headless run. No shell shim, and the child receives only explicit flags. */
export function childArguments({ prepared, loop, workTree, transcript, maxSteps, resume }) {
  const kind = loop.kind ?? "issue";
  const mode = loop.mode ?? "work-first";
  const args = [
    "--orchestrator",
    prepared.roles.orchestrator.kind,
    "--worker",
    prepared.roles.worker.kind,
    "--reviewer",
    prepared.roles.reviewer.kind,
    "--cwd",
    workTree,
    "--task",
    loop.task,
    "--max-steps",
    String(maxSteps),
    "--transcript",
    transcript,
  ];
  if (kind === "pr" || mode !== "work-first") args.push("--mode", mode);
  if (mode !== "review-only") args.push("--require-accept");
  for (const role of ["orchestrator", "worker", "reviewer"]) {
    const { model, effort } = prepared.roles[role];
    if (model) args.push(`--${role}-model`, model);
    if (effort) args.push(`--${role}-effort`, effort);
  }
  if (prepared.testCmd) args.push("--test-cmd", prepared.testCmd);
  if (prepared.testCmdTimeout) args.push("--test-cmd-timeout", String(prepared.testCmdTimeout));
  args.push("--timeout", String(prepared.timeout ?? 0));
  if (prepared.reviewerSandbox) args.push("--reviewer-sandbox", prepared.reviewerSandbox);
  if (resume.continueFrom) args.push("--continue-from", resume.continueFrom);
  const pr = resume.pr ?? (kind === "pr" ? loop.pr : null);
  if (mode !== "review-only" && pr !== null && pr !== undefined) {
    args.push("--pr", String(pr), "--require-ci", String(pr));
  }
  return args;
}

function shellCommand(command) {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]];
}

/** Runs `--setup-cmd` once in the new work tree through the platform shell, within its bound. */
export async function runSetup({ command, workTree, timeoutSeconds, signal = null, deps = {} }) {
  if (signal?.aborted) return false;
  const run = deps.execBounded ?? execBounded;
  const [file, args] = shellCommand(command);
  const result = await run(file, args, {
    cwd: workTree,
    timeoutMs: timeoutSeconds * 1000,
    signal,
  });
  return result.exitCode === 0 && !result.isCanceled && !signal?.aborted;
}

function cliPath() {
  return fileURLToPath(new URL("../cli.mjs", import.meta.url));
}

/** One line of the failure text, without the child argument list, for a loop reason. */
function spawnFailureText(error) {
  const cause = error?.cause?.message ?? error?.originalMessage ?? error?.message;
  const text = String(cause ?? "the child did not start").split("\n")[0];
  const code = typeof error?.code === "string" ? error.code : null;
  return code === null || text.includes(code) ? text : `${code}: ${text}`;
}

/** Returns a child that has a process id, and reports one that never started as an error. */
async function startedChild(child) {
  if (child.pid != null) return child;
  const { error } = await child.done;
  child.close?.();
  throw error ?? new Error("the child did not start");
}

/** Spawns one headless run with stdout and stderr appended to `logPath`. */
export async function spawnHeadless({ args, cwd, logPath, deps = {} }) {
  if (deps.spawn) return startedChild(await deps.spawn({ args, cwd, logPath }));
  // Execa opens one shared append stream for both output streams. It closes the stream on a normal
  // end or a spawn failure.
  const subprocess = killTreeOnExit(
    execa(process.execPath, [cliPath(), ...args], {
      cwd,
      reject: false,
      stdin: "ignore",
      stdout: { file: logPath, append: true },
      stderr: { file: logPath, append: true },
      killDescendants: true,
    }),
  );
  const pid = subprocess.pid ?? null;
  // With reject false, execa resolves a spawn failure as a failed result, not a rejection.
  const done = subprocess.then(
    (result) => ({
      exitCode: result.exitCode ?? null,
      error: result.failed ? result : null,
    }),
    (error) => ({ exitCode: null, error }),
  );
  return startedChild({
    pid,
    startTime: pid === null ? null : await processStartTime(pid),
    done,
    kill: (signal = "SIGINT") => {
      try {
        subprocess.kill(signal);
      } catch {
        // A run that already ended needs no signal.
      }
    },
    hardKill: () => {
      try {
        endSubprocessTree(subprocess);
      } catch {
        // A run that already ended needs no signal.
      }
    },
  });
}

const terminal = (status) => TERMINAL.has(status);
const loopEnded = (status) => terminal(status) || status === "interrupted";

function loopEntry(loop) {
  return {
    issue: loop.issue,
    ...(loop.kind !== undefined && loop.kind !== "issue"
      ? { kind: loop.kind, mode: loop.mode, number: loop.number ?? null }
      : {}),
    status: loop.status,
    skipReason: loop.skipReason,
    reason: loop.reason,
    workTree: loop.workTree?.path ?? null,
    branch: loop.branch,
    pr: loop.pr,
    attempts: loop.attempts,
    stepsUsed: loop.stepsUsed,
    remainingSteps: loop.remainingSteps,
    log: loop.log,
    transcript: loop.transcript,
    cleanup: loop.cleanup,
    decision: loop.decision ?? null,
    blockingIssues: loop.blockingIssues ?? [],
    report: loop.report ?? missingLoopReport(),
  };
}

function summaryOf(manifest, loops, skipped = new Map()) {
  const keys = Array.isArray(manifest.items)
    ? manifest.items.map((item) => item.key)
    : manifest.issues;
  return {
    batchId: manifest.id,
    status: manifest.status,
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

async function ownerStillLive(loop) {
  if (!isLive(loop)) return false;
  return ownerAlive({ pid: loop.pid, startTime: loop.startTime });
}

/**
 * Reads the frozen head, branch, and fork flag of every pull request item before the manifest is
 * written. A read that fails freezes no head, so eligibility later reports it unverified.
 */
export async function freezePullRequestItems(items, { gh, repo }) {
  const frozen = [];
  for (const item of items) {
    if (item.kind !== "pr") {
      frozen.push(item);
      continue;
    }
    try {
      const reply = await gh(
        [
          "pr",
          "view",
          String(item.number),
          "--json",
          "state,headRefOid,headRefName,isCrossRepository,title",
        ],
        repo,
      );
      if (reply?.status !== 0) {
        frozen.push({ ...item, head: null, headRefName: null, foreign: false });
        continue;
      }
      const view = JSON.parse(reply.stdout);
      if (typeof view?.headRefOid !== "string") {
        frozen.push({ ...item, head: null, headRefName: null, foreign: false });
        continue;
      }
      frozen.push({
        ...item,
        head: view.headRefOid,
        headRefName: typeof view.headRefName === "string" ? view.headRefName : null,
        foreign: view.isCrossRepository === true,
        title: typeof view.title === "string" ? view.title : null,
      });
    } catch {
      frozen.push({ ...item, head: null, headRefName: null, foreign: false });
    }
  }
  return frozen;
}

/** The task text of one item. An explicit per-item task replaces the template for that item. */
export function taskTextFor({ item, loop, prepared, title, branch }) {
  if (typeof item.task === "string" && item.task.trim() !== "") return item.task;
  if (item.kind === "task") {
    const base = item.text ?? loop.text ?? "";
    const delivery =
      item.mode === "review-only"
        ? "Review the work in this work tree and finish after the reviewer turn."
        : `Commit the change on branch ${branch}, push it with \`git push -u origin ${branch}\`, and open one pull request against the base branch whose body states the task and holds no closing keyword.`;
    return `${base}\n\n${delivery}`;
  }
  const template =
    item.kind === "pr" && prepared.taskTemplate === DEFAULT_TASK_TEMPLATE
      ? DEFAULT_PR_TASK_TEMPLATE
      : prepared.taskTemplate;
  return renderTask(template, {
    issue: item.number ?? item.key,
    title,
    branch,
    repo: prepared.repo,
  });
}

/**
 * Starts or resumes one batch. Returns `{ exitCode, summary }`. Every state write is a checkpoint
 * event; a quiet interval writes nothing.
 */
export async function runBatch({ prepared, runsRoot, gh, deps = {} }) {
  const paths = batchPaths(runsRoot);
  const id = prepared.id;
  let manifest;
  const loops = new Map();
  let start = true;
  let interrupted = false;
  let hard = false;
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
    const updated = await updateManifestReturning(runsRoot, id, (value) => ({
      ...value,
      status,
      ...(pausedReason === null ? {} : { pauseReason: pausedReason }),
    }));
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
    return {
      exitCode: exitCodeOf(manifest, loops),
      summary: summaryOf(
        manifest,
        loops,
        new Map((manifest.skipped ?? []).map((loop) => [loop.key, loop])),
      ),
    };
  };

  if (prepared.resume) {
    manifest = await readManifest(runsRoot, id);
    if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
    start = false;
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
          if (
            !["pr-head-moved", "pr-branch-diverged", "pr-branch-checked-out"].includes(err?.code)
          ) {
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

  const controller = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort(deps.signal.reason);
    else
      deps.signal.addEventListener("abort", () => controller.abort(deps.signal.reason), {
        once: true,
      });
  }

  const active = new Map();
  const children = new Map();
  const slots = new Set();
  const waiting = new Set();
  const pendingDecisions = new Set();
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const clock = { now: deps.now ?? (() => performance.now()), sleep: deps.sleep ?? defaultSleep };

  const forward = (signal) => {
    for (const child of children.values()) {
      if (signal === "SIGKILL") child.hardKill?.();
      else child.kill?.("SIGINT");
    }
  };
  const onSigInt = () => {
    if (!interrupted) {
      interrupted = true;
      progress("interrupted: stopping new launches and forwarding SIGINT");
      controller.abort();
      forward("SIGINT");
      for (const [issue, child] of children) {
        const timer = setTimeout(() => {
          if (children.has(issue)) child.hardKill?.();
        }, INTERRUPT_WAIT_MS);
        timer.unref?.();
      }
    } else if (!hard) {
      hard = true;
      progress("second interrupt: ending the child trees now");
      forward("SIGKILL");
    }
  };
  const installSignal = deps.installSignal !== false;
  if (installSignal) process.on("SIGINT", onSigInt);
  if (deps.signal) {
    deps.signal.addEventListener("abort", () => {
      if (!interrupted) {
        interrupted = true;
        controller.abort(deps.signal.reason);
        forward("SIGINT");
      }
    });
  }

  // A loop end reads its transcript once and stores the report in the same checkpoint write as the
  // status change. The report adds no store write.
  const changeLoop = async (issue, patch) => {
    let nextPatch = patch;
    if (patch?.status !== undefined && loopEnded(patch.status) && patch.report === undefined) {
      const current = loops.get(issue) ?? (await readLoop(runsRoot, id, issue));
      nextPatch = {
        ...patch,
        report: await readLoopReport(current.transcript, {
          attempts: current.attempts,
          reviewOnly: current.mode === "review-only",
        }),
      };
    }
    const changed = await updateLoop(
      runsRoot,
      id,
      issue,
      (current) => ({
        ...current,
        ...nextPatch,
      }),
      { initial: loops.get(issue) ?? null },
    );
    loops.set(issue, await readLoop(runsRoot, id, issue));
    return changed;
  };

  const refreshOpenPr = async () => {
    try {
      return await readOpenPrClosures({ gh, repo: prepared.repo });
    } catch (err) {
      throw Object.assign(new Error(`the open pull request read failed: ${err.message}`), {
        batchWide: true,
      });
    }
  };

  const createWorkTree = deps.createWorkTree ?? createLoopWorkTree;
  const createPullRequestWorkTree =
    deps.createPrWorkTree ?? deps.createWorkTree ?? createPrWorkTree;
  const planTree = deps.planPrWorkTree ?? planPrWorkTree;
  const reconcile = deps.reconcileLoop ?? reconcileLoop;
  const cleanupWorkTree = deps.cleanupLoop ?? cleanupLoop;
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
    if (workTree.detached === true) {
      const head = await gitRead(["rev-parse", "HEAD"], workTree.path);
      return head.exitCode === 0 && head.stdout === workTree.head
        ? null
        : "the recorded head is not checked out";
    }
    const branch = await gitRead(["rev-parse", "--abbrev-ref", "HEAD"], workTree.path);
    return branch.exitCode === 0 && branch.stdout === workTree.branch
      ? null
      : "the recorded branch is not checked out";
  };

  const verifyWorkTree = deps.verifyWorkTree ?? verifyRecordedWorkTree;

  const optionKeysOf = (decision) =>
    (decision?.options ?? DECISION_OPTIONS).map((option) => option.key).join(", ");

  const decisionOptions = (decision) => decision.options.map((option) => option.key);

  const markNeedsOwner = async (issue, reason, { evidence = null, extra = {} } = {}) => {
    const current = await readLoop(runsRoot, id, issue);
    const attempt = Number.isInteger(current?.attempts) ? current.attempts : 0;
    let decisionId = null;
    let created = false;
    const options = optionsForReason(reason);
    const recommended = recommendedOf(options);

    if (typeof current?.decision === "string") {
      const existing = await readDecision(runsRoot, id, current.decision);
      if (
        existing !== null &&
        existing.ok &&
        existing.decision.reason === reason &&
        existing.decision.attempt === attempt
      ) {
        const answer = await readAnswer(
          runsRoot,
          id,
          current.decision,
          decisionOptions(existing.decision),
          issue,
        );
        const applied = current.decisionAnswer != null;
        if (answer === null || !applied) decisionId = current.decision;
      }
    }
    if (decisionId === null) {
      let idForState = newDecisionId(id, issue, attempt, reason);
      const existingAtId = await readDecision(runsRoot, id, idForState);
      if (existingAtId !== null && !existingAtId.ok) {
        const refusal = `the decision file is unreadable: ${existingAtId.reason}`;
        logWarn(`issue ${issue}: ${refusal}`);
        await changeLoop(issue, {
          status: "needs-owner",
          reason: refusal,
          skipReason: null,
          decision: idForState,
          ...extra,
        });
        pendingDecisions.add(issue);
        return false;
      }
      if (existingAtId !== null && existingAtId.ok) {
        const sameState =
          existingAtId.decision.reason === reason && existingAtId.decision.attempt === attempt;
        const answer = await readAnswer(
          runsRoot,
          id,
          idForState,
          decisionOptions(existingAtId.decision),
          issue,
        );
        if (sameState && answer === null) {
          decisionId = idForState;
        } else {
          idForState = `${idForState}-${randomUUID().slice(0, 8)}`;
        }
      }
      if (decisionId === null) {
        const result = await createDecision({
          runsRoot,
          batchId: id,
          id: idForState,
          issue,
          attempt,
          reason,
          evidence,
          options,
          recommended,
        });
        if (result.decision === null) {
          const refusal = `the decision file is unreadable: ${result.error ?? idForState}`;
          logWarn(`issue ${issue}: ${refusal}`);
          await changeLoop(issue, {
            status: "needs-owner",
            reason: refusal,
            skipReason: null,
            decision: idForState,
            ...extra,
          });
          pendingDecisions.add(issue);
          return false;
        }
        decisionId = result.decision.id;
        created = result.created;
      }
    }
    // A recorded live process keeps its pid and stamp, so a later resume re-checks it first.
    await changeLoop(issue, {
      status: "needs-owner",
      reason,
      skipReason: null,
      decision: decisionId,
      ...(created ? { decisionAnswer: null } : {}),
      ...extra,
    });
    pendingDecisions.add(issue);
    if (created) {
      logInfo(`issue ${issue}: decision ${decisionId} created (${reason})`);
      const read = await readDecision(runsRoot, id, decisionId);
      const decision = read?.ok ? read.decision : null;
      await sendNotification({
        kind: "decision",
        title: "Batch decision needed",
        text: `Batch ${id} issue ${issue} needs a decision: ${reason}. Options: ${optionKeysOf(decision)}. Recommended: ${recommendedOf(decision?.options ?? options)}. Answer: agent-loop batch answer --batch ${id} --decision ${decisionId} --option <key>`,
      });
    }
    return created;
  };

  const markPrHeadUnresolved = async (issue, loop, { pr, stepsUsed, remainingSteps }) => {
    const report = await readLoopReport(loop.transcript, {
      attempts: loop.attempts,
      reviewOnly: loop.mode === "review-only",
    });
    return markNeedsOwner(issue, "pr-head-unresolved", {
      evidence: pr === null ? "the transcript records no pull request" : `pull request ${pr}`,
      extra: { pr, stepsUsed, remainingSteps, pid: null, startTime: null, report },
    });
  };

  const applyDecisionAnswer = async (issue, current) => {
    if (isLive(current) && (await ownerAlive({ pid: current.pid, startTime: current.startTime }))) {
      return { kind: "pending" };
    }
    if (typeof current.decision !== "string") {
      await markNeedsOwner(issue, current.reason ?? "needs-owner", {
        evidence: current.reason ?? null,
      });
      return { kind: "pending" };
    }
    const decision = await readDecision(runsRoot, id, current.decision);
    if (decision === null || !decision.ok) {
      logWarn(`issue ${issue}: decision ${current.decision} is unreadable. The loop stays pending`);
      return { kind: "malformed" };
    }
    const answer = await readAnswer(
      runsRoot,
      id,
      current.decision,
      decisionOptions(decision.decision),
      current.issue,
    );
    if (answer !== null && !answer.ok) {
      logWarn(`issue ${issue}: answer ${current.decision} is unreadable. The loop stays pending`);
      return { kind: "malformed" };
    }
    if (answer === null) return { kind: "pending" };
    const option = answer.answer.option;
    if (option === "resume") {
      await changeLoop(issue, {
        status: "queued",
        reason: null,
        skipReason: null,
        decisionAnswer: option,
      });
      return { kind: "resume", loop: await readLoop(runsRoot, id, issue) };
    }
    if (option === "abandon" || option === "skip") {
      const patch =
        option === "abandon"
          ? { status: "failed", reason: ABANDON_REASON, skipReason: null }
          : { status: "skipped", skipReason: SKIP_REASON, reason: "the owner stopped the loop" };
      await changeLoop(issue, { ...patch, decisionAnswer: option });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
      return { kind: "terminal" };
    }
    logWarn(`issue ${issue}: decision ${current.decision} names an unknown option`);
    return { kind: "malformed" };
  };

  const launchIssue = async (issue, { recovery = null } = {}) => {
    let loop = loops.get(issue);
    const item = {
      kind: loop.kind ?? "issue",
      key: loop.issue,
      number: loop.number ?? (typeof loop.issue === "number" ? loop.issue : null),
      text: loop.text ?? null,
      mode: loop.mode ?? "work-first",
      task: loop.taskOverride ?? null,
      head: loop.head ?? null,
      headRefName: loop.headRefName ?? null,
      foreign: loop.foreign === true,
    };
    if (recovery === null) {
      let closures = null;
      if (item.kind === "issue") {
        try {
          closures = await refreshOpenPr();
        } catch (err) {
          pausedReason = err.message;
          await changeLoop(issue, {
            status: "queued",
            reason: "eligibility-unverified",
            skipReason: "eligibility-unverified",
          });
          throw err;
        }
        if (closures.incompletePr !== null) {
          pausedReason = `pull request ${closures.incompletePr} returned a 250-commit page`;
          await changeLoop(issue, {
            status: "queued",
            skipReason: "eligibility-unverified",
            reason: pausedReason,
          });
          throw Object.assign(new Error(pausedReason), { batchWide: true });
        }
      }
      const claim = await readClaim(runsRoot, prepared.repoKey, issue);
      const eligibility = await checkItemEligibility({
        item,
        gh,
        repo: prepared.repo,
        batchId: id,
        claim,
        openPrClosures: closures,
        ownPr: loop.pr,
        ownBranch: loop.branch,
        requireSpecification: prepared.requireSpecification === true,
      });
      if (!eligibility.ok) {
        if (eligibility.reason === "blocked") {
          waiting.add(issue);
          const changed = await changeLoop(issue, {
            status: "waiting",
            skipReason: "blocked",
            reason: eligibility.evidence,
            blockingIssues: eligibility.blocking ?? [],
            remainingSteps: loop.remainingSteps,
            pid: null,
            startTime: null,
          });
          progress(`issue ${issue}: waiting (${eligibility.evidence})`);
          if (changed) {
            await sendNotification({
              kind: "merge-required",
              title: "Batch merge required",
              text: `Batch ${id} issue ${issue} waits for the merge of blocking issue(s) ${(eligibility.blocking ?? []).join(", ")}.`,
            });
          }
          return;
        }
        await changeLoop(issue, {
          status: "skipped",
          skipReason: eligibility.reason,
          reason: eligibility.evidence,
          remainingSteps: loop.remainingSteps,
        });
        progress(`issue ${issue}: skipped (${eligibility.reason}: ${eligibility.evidence})`);
        return;
      }
      if (item.kind === "pr") {
        try {
          await planTree({
            repo: prepared.repo,
            branch: loop.branch,
            head: loop.head,
            number: item.number,
          });
        } catch (err) {
          if (
            !["pr-head-moved", "pr-branch-diverged", "pr-branch-checked-out"].includes(err?.code)
          ) {
            throw err;
          }
          await changeLoop(issue, {
            status: "skipped",
            skipReason: err.code,
            reason: err.message,
            remainingSteps: loop.remainingSteps,
          });
          progress(`issue ${issue}: skipped (${err.code}: ${err.message})`);
          return;
        }
      }
      const ownClaim = claim.exists && claim.record?.batchId === id;
      const claimResult = ownClaim
        ? { acquired: true }
        : await acquireClaim(
            runsRoot,
            prepared.repoKey,
            issue,
            {
              batchId: id,
              repo: prepared.repo,
              workTree: prepared.workTreeRoot,
              pid: process.pid,
              startTime: await ownStartTimeOnce(),
            },
            {
              onStale: async (record) => {
                if (record.batchId === id) return true;
                const owner = await readLoop(runsRoot, record.batchId, issue).catch(() => null);
                return owner?.status === "failed";
              },
            },
          );
      if (!claimResult.acquired) {
        await changeLoop(issue, {
          status: "skipped",
          skipReason: "claimed",
          reason: `claimed by batch ${claimResult.owner ?? "unknown"}`,
        });
        progress(`issue ${issue}: skipped (claimed by batch ${claimResult.owner ?? "unknown"})`);
        return;
      }
      let title = item.kind === "issue" ? `issue ${item.number}` : `pull request ${item.number}`;
      if (item.kind === "pr" && typeof loop.prTitle === "string" && loop.prTitle.trim() !== "") {
        title = loop.prTitle;
      }
      if (item.kind === "issue") {
        try {
          const reply = await gh(
            ["issue", "view", String(item.number), "--json", "title"],
            prepared.repo,
          );
          if (reply?.status === 0) {
            const parsed = JSON.parse(reply.stdout);
            if (typeof parsed?.title === "string" && parsed.title.trim() !== "") {
              title = parsed.title;
            }
          }
        } catch {
          // A missing title keeps the issue number in the task.
        }
      }
      const task = taskTextFor({
        item,
        loop,
        prepared,
        title,
        branch: loop.branch,
      });
      const workTreePath = join(prepared.workTreeRoot, loopSegment(issue));
      const recordedWorkTree = loop.workTree;
      let workTree = recordedWorkTree;
      try {
        if (workTree === null || workTree === undefined) {
          workTree =
            item.kind === "pr"
              ? await createPullRequestWorkTree({
                  repo: prepared.repo,
                  base: prepared.base,
                  workTree: workTreePath,
                  branch: loop.branch,
                  head: loop.head,
                  foreign: loop.foreign === true,
                  number: item.number,
                })
              : await createWorkTree({
                  repo: prepared.repo,
                  base: prepared.base,
                  workTree: workTreePath,
                  branch: loop.branch,
                });
        }
      } catch (err) {
        if (["pr-head-moved", "pr-branch-diverged", "pr-branch-checked-out"].includes(err?.code)) {
          await changeLoop(issue, {
            status: "skipped",
            skipReason: err.code,
            reason: err.message,
            workTree: null,
            remainingSteps: loop.remainingSteps,
          });
          await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
          progress(`issue ${issue}: skipped (${err.code}: ${err.message})`);
          return;
        }
        await changeLoop(issue, {
          status: "failed",
          reason: `work-tree-failed: ${err.message}`,
          workTree: null,
        });
        await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
        logError(`issue ${issue}: failed (work-tree-failed: ${err.message})`);
        return;
      }
      loop = { ...loop, task, workTree };
      const continuation = loop.decisionAnswer != null;
      let freshRecovery = { continueFrom: null, pr: null };
      if (recordedWorkTree !== null && recordedWorkTree !== undefined) {
        const refused = await verifyWorkTree(loop);
        if (refused !== null) {
          await markNeedsOwner(issue, refused, { evidence: refused });
          return;
        }
        if (!continuation) {
          const decision = await reconcile({
            loop,
            repo: prepared.repo,
            base: prepared.base,
            gh,
            deps,
          });
          if (decision.status === "succeeded") {
            await finishSuccess(issue, loop, {
              stepsUsed: loop.stepsUsed,
              remainingSteps: loop.remainingSteps,
              pr: decision.pr ?? loop.pr,
            });
            return;
          }
          if (decision.status === "needs-owner") {
            await markNeedsOwner(issue, decision.reason, { evidence: decision.reason });
            return;
          }
          const continueFrom = loop.attempts > 0 ? loop.transcript : null;
          freshRecovery = { continueFrom, pr: decision.pr ?? loop.pr };
        }
      }
      await changeLoop(issue, {
        workTree,
        task,
        status: "queued",
        setupDone: loop.setupDone === true,
        pr: freshRecovery.pr ?? loop.pr,
      });
      if (continuation) {
        await continueLoop(issue, loop);
        return;
      }
      if (prepared.setupCmd && loop.setupDone !== true) {
        const ok = await runSetup({
          command: prepared.setupCmd,
          workTree: workTree.path,
          timeoutSeconds: prepared.setupTimeout,
          signal: controller.signal,
          deps,
        });
        if (!ok && (interrupted || hard)) return;
        if (!ok) {
          await changeLoop(issue, { status: "failed", reason: "setup-failed" });
          await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
          logError(`issue ${issue}: failed (setup-failed)`);
          return;
        }
        await changeLoop(issue, { setupDone: true });
      }
      if (interrupted || hard) return;
      await changeLoop(issue, { attempts: loop.attempts + 1 });
      loop = loops.get(issue);
      return startChild(issue, loop, { resume: freshRecovery });
    }

    if (interrupted || hard) return;
    await changeLoop(issue, { attempts: loop.attempts + 1 });
    loop = loops.get(issue);
    return startChild(issue, loop, { resume: recovery });
  };

  const startChild = async (issue, loop, { resume }) => {
    if (interrupted || hard) return;
    const attempt = loop.attempts;
    const logPath = paths.log(id, issue, attempt);
    const args = childArguments({
      prepared,
      loop,
      workTree: loop.workTree.path,
      transcript: loop.transcript,
      maxSteps: loop.remainingSteps,
      resume,
    });
    await changeLoop(issue, {
      status: "running",
      skipReason: null,
      reason: null,
      log: logPath,
      pid: null,
      startTime: null,
      decisionAnswer: null,
    });
    let child;
    try {
      child = await spawnHeadless({
        args,
        cwd: loop.workTree.path,
        logPath,
        deps,
      });
    } catch (err) {
      const text = spawnFailureText(err);
      await changeLoop(issue, {
        status: "failed",
        reason: `child-error: ${text}`,
      });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
      logError(`issue ${issue}: failed (child-error: ${text})`);
      return;
    }
    children.set(issue, child);
    slots.add(issue);
    if (interrupted || hard) child.kill?.("SIGINT");
    await changeLoop(issue, { pid: child.pid ?? null, startTime: child.startTime ?? null });
    progress(`issue ${issue}: attempt ${attempt} started (pid ${child.pid ?? "unknown"})`);
    const promise = (async () => {
      const { exitCode } = await child.done;
      child.close?.();
      children.delete(issue);
      slots.delete(issue);
      await finishChild(issue, exitCode, { interrupted: interrupted || hard });
    })();
    active.set(issue, promise);
    promise.finally(() => active.delete(issue));
  };

  const finishChild = async (issue, exitCode, { interrupted: wasInterrupted }) => {
    let loop = await readLoop(runsRoot, id, issue);
    const steps = await readStepsUsed(loop.transcript, {
      checkpointSteps: loop.stepsUsed,
      attempts: loop.attempts,
    });
    const stepsUsed = steps.ok ? steps.steps : loop.stepsUsed;
    const remainingSteps = Math.max(0, prepared.maxSteps - stepsUsed);
    const common = { stepsUsed, remainingSteps, pid: null, startTime: null };

    if (wasInterrupted || exitCode === 130) {
      await changeLoop(issue, { ...common, status: "interrupted", reason: "interrupted" });
      progress(`issue ${issue}: interrupted`);
      return;
    }
    if (exitCode === 0) {
      await changeLoop(issue, { ...common, status: "succeeded" });
      loop = await readLoop(runsRoot, id, issue);
      const cleanup = await cleanupWorkTree({
        manifest,
        loop,
        runsRoot,
        gh,
      }).catch((err) => ({ removed: false, reason: err.message }));
      await changeLoop(issue, { cleanup });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
      progress(
        `issue ${issue}: succeeded${cleanup.removed ? " (work tree removed)" : ` (work tree kept: ${cleanup.reason})`}`,
      );
      return;
    }
    if (exitCode === 4) {
      const transcript = await readTranscript(loop.transcript);
      let declaredPr = loop.pr;
      try {
        declaredPr = declaredPrFromTranscript(transcript) ?? loop.pr;
      } catch (err) {
        await markNeedsOwner(
          issue,
          `the transcript declares an unreadable pull request: ${err.message}`,
          { evidence: err.message, extra: common },
        );
        return;
      }
      await markPrHeadUnresolved(issue, loop, { ...common, pr: declaredPr });
      progress(`issue ${issue}: needs-owner (pr-head-unresolved)`);
      return;
    }
    await changeLoop(issue, {
      ...common,
      status: "failed",
      reason: `exit-${exitCode ?? "unknown"}`,
    });
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
    logError(`issue ${issue}: failed (exit ${exitCode ?? "unknown"})`);
  };

  const readTranscript = async (file) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  };

  const finishSuccess = async (issue, loop, { stepsUsed, remainingSteps, pr }) => {
    await changeLoop(issue, {
      status: "succeeded",
      reason: null,
      skipReason: null,
      stepsUsed,
      remainingSteps,
      pr: pr ?? loop.pr,
      pid: null,
      startTime: null,
    });
    const updated = await readLoop(runsRoot, id, issue);
    const cleanup = await cleanupWorkTree({ manifest, loop: updated, runsRoot, gh }).catch(
      (err) => ({
        removed: false,
        reason: err.message,
      }),
    );
    await changeLoop(issue, { cleanup });
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
  };

  const finishFailure = async (issue, loop, reason, { stepsUsed, remainingSteps }) => {
    logError(`issue ${issue}: failed (${reason})`);
    await changeLoop(issue, {
      status: "failed",
      reason,
      stepsUsed,
      remainingSteps,
      pid: null,
      startTime: null,
    });
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
  };

  const withLoopOwnership = async (issue, fn) => {
    const lockFile = join(paths.batchDir(id), "loops", `${loopSegment(issue)}.resume.lock`);
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    if (release === null) {
      lockSkipped.add(issue);
      progress(`issue ${issue}: another resume owns the loop`);
      return;
    }
    try {
      await fn();
    } finally {
      await release();
    }
  };

  // A pending-decision refresh takes the loop lock so a held lock reports paused, as #1728
  // requires. A null result means another resume owns the loop and the caller keeps it pending.
  const withLoopResult = async (issue, fn) => {
    const lockFile = join(paths.batchDir(id), "loops", `${loopSegment(issue)}.resume.lock`);
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    if (release === null) {
      lockSkipped.add(issue);
      return null;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  };

  /**
   * Continues one loop from its transcript. It reads the steps, applies the exhaustion check,
   * reconciles GitHub, and launches with --continue-from and the recorded pull request.
   */
  const continueLoop = async (issue, initial) => {
    let loop = initial;
    const transcript = await readTranscript(loop.transcript);
    if (transcript === null && loop.attempts > 0) {
      await markNeedsOwner(issue, "unverified-steps", {
        evidence: "the transcript is missing",
      });
      return;
    }
    let declaredPr = loop.pr;
    try {
      declaredPr = declaredPrFromTranscript(transcript) ?? loop.pr;
    } catch (err) {
      await markNeedsOwner(
        issue,
        `the transcript declares an unreadable pull request: ${err.message}`,
        {
          evidence: err.message,
        },
      );
      return;
    }
    loop = { ...loop, pr: declaredPr };

    const recordedExit = await readTranscriptExit(loop.transcript);
    const steps = await readStepsUsed(loop.transcript, {
      checkpointSteps: loop.stepsUsed,
      attempts: loop.attempts,
    });
    const stepsUsed = steps.ok ? steps.steps : loop.stepsUsed;
    const remainingSteps = Math.max(0, prepared.maxSteps - stepsUsed);
    if (recordedExit.ok && recordedExit.proven && recordedExit.exitCode === 0) {
      await finishSuccess(issue, loop, { stepsUsed, remainingSteps, pr: loop.pr });
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
        stepsUsed,
        remainingSteps,
      });
      return;
    }
    if (recordedExit.ok && recordedExit.proven && [1, 2].includes(recordedExit.exitCode)) {
      await finishFailure(issue, loop, `exit-${recordedExit.exitCode}`, {
        stepsUsed,
        remainingSteps,
      });
      return;
    }
    if (!steps.ok) {
      await markNeedsOwner(issue, "unverified-steps", {
        evidence: steps.reason ?? "the step count is unreadable",
        extra: { stepsUsed, remainingSteps },
      });
      return;
    }
    if (remainingSteps <= 0) {
      await finishFailure(issue, loop, "step-budget-exhausted", {
        stepsUsed,
        remainingSteps: 0,
      });
      return;
    }
    const decision = await reconcile({
      loop,
      repo: prepared.repo,
      base: prepared.base,
      gh,
      deps,
    });
    if (decision.status === "succeeded") {
      await finishSuccess(issue, loop, {
        stepsUsed,
        remainingSteps,
        pr: decision.pr ?? loop.pr,
      });
      return;
    }
    if (decision.status === "needs-owner") {
      await markNeedsOwner(issue, decision.reason, {
        evidence: decision.reason,
        extra: { stepsUsed, remainingSteps },
      });
      return;
    }
    await changeLoop(issue, {
      stepsUsed,
      remainingSteps,
      pr: decision.pr ?? loop.pr,
      pid: null,
      startTime: null,
    });
    await launchIssue(issue, {
      recovery: { continueFrom: loop.transcript, pr: decision.pr ?? loop.pr },
    });
  };

  const recover = async (issue, initial) => {
    let loop = initial;
    if (isLive(loop)) {
      // A recorded live PID is never restarted. Without a readable identity the loop needs its
      // owner instead of waiting forever (adr/0106-foreground-batch-scheduling.md decision 10).
      const current = await processStartTime(loop.pid);
      if (pidAlive(loop.pid) && (loop.startTime == null || current === null)) {
        // Keep the recorded PID and stamp: a later resume must re-check it before any launch.
        await markNeedsOwner(issue, "unverified-process-identity", {
          evidence: "the process start stamp cannot be read",
        });
        return;
      }
      while (await ownerStillLive(loop)) {
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
  const readWaitState = async (issue) => {
    const reply = await gh(
      ["issue", "view", String(issue), "--json", "state,blockedBy"],
      prepared.repo,
      { signal: controller.signal, timeoutMs: POLL_READ_TIMEOUT_MS },
    );
    if (reply?.timedOut) throw new Error("the read reached its bound");
    if (reply?.status !== 0) {
      throw new Error((reply?.stderr ?? "").trim() || `exit ${reply?.status ?? "unknown"}`);
    }
    const value = JSON.parse(reply.stdout);
    const nodes = Array.isArray(value?.blockedBy)
      ? value.blockedBy
      : Array.isArray(value?.blockedBy?.nodes)
        ? value.blockedBy.nodes
        : null;
    if (typeof value?.state !== "string" || nodes === null) {
      throw new Error("the wait read returned an unreadable value");
    }
    const open = nodes
      .filter((node) => String(node?.state ?? "").toUpperCase() === "OPEN")
      .map((node) => node?.number)
      .filter(Number.isInteger);
    return { state: value.state, open };
  };
  const recheckWaiting = async (issue) => {
    let read;
    try {
      read = await readWaitState(issue);
    } catch (err) {
      if (interrupted || hard) return "wait";
      logWarn(`issue ${issue}: the wait read failed: ${err.message}. Retrying on the next poll`);
      return "wait";
    }
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
        await sendNotification({
          kind: "merge-required",
          title: "Batch merge required",
          text: `Batch ${id} issue ${issue} waits for the merge of blocking issue(s) ${read.open.join(", ")}.`,
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
    for (const issue of waiting) {
      const result = await recheckWaiting(issue);
      if (result === "done") waiting.delete(issue);
      else if (result === "ready") {
        waiting.delete(issue);
        remaining.add(issue);
      }
    }
  };
  const refreshPendingDecisions = async () => {
    for (const issue of pendingDecisions) {
      const current = await readLoop(runsRoot, id, issue);
      if (current === null) continue;
      loops.set(issue, current);
      if (current.status !== "needs-owner") {
        pendingDecisions.delete(issue);
        if (current.status === "queued") remaining.add(issue);
        continue;
      }
      if (isLive(current)) {
        if (await ownerAlive({ pid: current.pid, startTime: current.startTime })) {
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
    for (const issue of manifest.issues) {
      const current = await readLoop(runsRoot, id, issue);
      if (current !== null) loops.set(issue, current);
    }
  };
  // A recorded child that this process did not spawn holds its slot until its process ends.
  const refreshHeld = async () => {
    for (const issue of slots) {
      if (active.has(issue)) continue;
      const current = await readLoop(runsRoot, id, issue);
      if (current === null || !isLive(current)) {
        slots.delete(issue);
        continue;
      }
      if (!(await ownerAlive({ pid: current.pid, startTime: current.startTime }))) {
        slots.delete(issue);
      }
    }
  };
  for (const issue of manifest.issues) {
    const loop = loops.get(issue);
    if (loop !== null && isLive(loop)) {
      if (await ownerAlive({ pid: loop.pid, startTime: loop.startTime })) slots.add(issue);
    }
  }
  await refreshPendingDecisions();
  // An issue that already holds a slot is taken for its own recovery or launch. A new issue
  // enters only while a slot is free.
  const canTake = () => {
    const issue = nextIssue();
    if (issue === null) return false;
    return slots.has(issue) || slots.size < prepared.loops;
  };
  let pollLogged = false;
  let nextPoll = clock.now() + pollIntervalMs;
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
            await launchIssue(issue);
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
    if (hard || interrupted) break;
    if (pausedReason !== null && active.size === 0) break;
    const hasRecordedHeld = () => slots.size > active.size;
    const pollingNeeded =
      waiting.size > 0 || pendingDecisions.size > 0 || (hasRecordedHeld() && remaining.size > 0);
    if (pollingNeeded && !pollLogged) {
      pollLogged = true;
      logInfo(`waiting poll started for issue(s) ${[...waiting, ...pendingDecisions].join(", ")}`);
    }
    if (active.size > 0) {
      const racers = [...active.values()];
      let pollElapsed = false;
      let pollController = null;
      if (pollingNeeded) {
        pollController = new AbortController();
        const wait = Math.max(0, nextPoll - clock.now());
        const pollSignal = AbortSignal.any([controller.signal, pollController.signal]);
        racers.push(
          pollWait(wait, pollSignal, clock).then(() => {
            pollElapsed = true;
          }),
        );
      }
      await Promise.race(racers);
      pollController?.abort();
      if (interrupted || hard) break;
      if (pollElapsed) {
        nextPoll = clock.now() + pollIntervalMs;
        await syncFromDisk();
        await refreshHeld();
        await refreshWaiting();
        await refreshPendingDecisions();
      }
      continue;
    }
    if (pausedReason !== null) break;
    if (waiting.size === 0 && pendingDecisions.size === 0 && !hasRecordedHeld()) break;
    if (waiting.size > 0 || (hasRecordedHeld() && remaining.size > 0)) {
      const wait = Math.max(0, nextPoll - clock.now());
      await pollWait(wait, controller.signal, clock);
      if (interrupted || hard) break;
      nextPoll = clock.now() + pollIntervalMs;
      await syncFromDisk();
      await refreshHeld();
      await refreshWaiting();
      await refreshPendingDecisions();
      continue;
    }
    // Only pending decisions remain. Apply a live answer that already arrived, then stop.
    await syncFromDisk();
    await refreshHeld();
    await refreshPendingDecisions();
    if (remaining.size > 0) continue;
    break;
  }
  if (pollLogged) logInfo("waiting poll stopped");
  // A resume runs its recovered loops one at a time; this drains any that the pass left live.
  while (active.size > 0 && !hard) await Promise.race(active.values());

  if (installSignal) process.removeListener("SIGINT", onSigInt);
  return finalizeBatch();
}

async function updateManifestReturning(runsRoot, id, updater) {
  const changed = await updateManifest(runsRoot, id, updater);
  return { manifest: await readManifest(runsRoot, id), changed };
}

async function decisionView(runsRoot, batchId, loop) {
  if (typeof loop.decision !== "string") return null;
  const read = await readDecision(runsRoot, batchId, loop.decision);
  if (read === null) {
    return { id: loop.decision, state: "malformed", error: "the decision file is missing" };
  }
  if (!read.ok) {
    return { id: loop.decision, state: "malformed", error: read.reason };
  }
  const { decision } = read;
  const view = {
    id: decision.id,
    state: "pending",
    reason: decision.reason,
    evidence: decision.evidence,
    options: decision.options.map((option) => option.key),
    recommended: decision.recommended,
    answer: null,
  };
  const answer = await readAnswer(
    runsRoot,
    batchId,
    loop.decision,
    decision.options.map((option) => option.key),
    loop.issue,
  );
  if (answer !== null && !answer.ok) {
    return { ...view, state: "malformed", error: answer.reason };
  }
  if (answer !== null) {
    return { ...view, state: "answered", answer: { option: answer.answer.option } };
  }
  return view;
}

/** The next action of a loop that needs its owner, or null when no named action exists. */
function nextActionOf(loop) {
  if (loop.status !== "needs-owner" || loop.reason !== "pr-head-unresolved") return null;
  if (loop.pr == null) {
    return `compare branch ${loop.branch} with the reviewed commit, then merge or resume. The pull request number is not recorded`;
  }
  return `compare pull request ${loop.pr} head with the reviewed commit, then merge or resume`;
}

/** Reads one batch for `batch status`; a live-owner checkpoint that is gone reads `stale`. */
export async function readBatchStatus({ runsRoot, id }) {
  const manifest = await readManifest(runsRoot, id);
  if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
  const loops = [];
  const skipped = new Map((manifest.skipped ?? []).map((loop) => [loop.key, loop]));
  const keys = Array.isArray(manifest.items)
    ? manifest.items.map((item) => item.key)
    : manifest.issues;
  const runnable = new Set(manifest.issues);
  for (const issue of keys) {
    if (!runnable.has(issue)) {
      const skippedLoop = skipped.get(issue);
      if (skippedLoop === undefined) continue;
      loops.push({
        ...loopEntry(skippedLoop),
        decision: null,
        blockingIssues: [],
        requiredMerges: [],
        nextAction: null,
      });
      continue;
    }
    const loop = await readLoop(runsRoot, id, issue);
    if (loop === null) {
      const item = (manifest.items ?? []).find((entry) => entry.key === issue);
      if (item === undefined) continue;
      loops.push({
        ...loopEntry(queuedLoop(batchPaths(runsRoot), id, item, manifest.settings?.maxSteps ?? 0)),
        decision: null,
        blockingIssues: [],
        requiredMerges: [],
        nextAction: "batch resume",
      });
      continue;
    }
    const waitDetails = {
      decision: await decisionView(runsRoot, id, loop),
      blockingIssues: Array.isArray(loop.blockingIssues) ? loop.blockingIssues : [],
      requiredMerges: loop.status === "waiting" ? (loop.blockingIssues ?? []) : [],
    };
    if (loop.status === "running" && loop.pid != null) {
      const live = await ownerAlive({ pid: loop.pid, startTime: loop.startTime });
      loops.push({
        ...loopEntry(loop),
        ...waitDetails,
        status: live ? "running" : "stale",
        nextAction: live ? null : "batch resume",
      });
    } else loops.push({ ...loopEntry(loop), ...waitDetails, nextAction: nextActionOf(loop) });
  }
  return {
    ...manifest,
    completion: {
      status: manifest.status,
      complete: ["completed", "failed"].includes(manifest.status),
    },
    loops,
  };
}

/** The local batches, newest first, for `batch status` with no id. */
export async function listBatchStatus({ runsRoot }) {
  return listBatches(runsRoot);
}
