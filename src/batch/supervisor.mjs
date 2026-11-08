// The one foreground supervisor of a batch (ADR 0106 decisions 1, 4, 5, 6, 9, 10, 12). It launches
// one headless child per issue, prints progress on stderr, and returns one summary for stdout.
import { createWriteStream } from "node:fs";
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
import { renderTask } from "./args.mjs";
import { cleanupLoop } from "./cleanup.mjs";
import {
  ABANDON_REASON,
  DECISION_OPTIONS,
  RECOMMENDED_OPTION,
  createDecision,
  newDecisionId,
  readAnswer,
  readDecision,
} from "./decisions.mjs";
import { checkEligibility, readOpenPrClosures } from "./eligibility.mjs";
import { notify as defaultNotify } from "./notifier.mjs";
import { createLoopWorkTree, git as gitRead, identityEqual, pathIdentity } from "./git.mjs";
import { reconcileLoop } from "./reconcile.mjs";
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

// A needs-owner loop becomes a pending decision and releases its slot (ADR 0109 decision 1).
// A waiting loop keeps its checkpoint and is re-checked on the poll (ADR 0109 decision 5).
const TERMINAL = new Set(["succeeded", "skipped", "failed"]);
const INTERRUPT_WAIT_MS = 30_000;
/** The wait between two re-checks of a blocked issue (ADR 0109 decision 5). */
export const POLL_INTERVAL_MS = 15_000;

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

function queuedLoop(paths, id, issue, maxSteps) {
  return {
    issue,
    status: "queued",
    skipReason: null,
    reason: null,
    attempts: 0,
    branch: `batch/${id}/${issue}`,
    workTree: null,
    transcript: paths.transcript(id, issue),
    log: null,
    pid: null,
    startTime: null,
    stepsUsed: 0,
    remainingSteps: maxSteps,
    pr: null,
    cleanup: null,
    decision: null,
    decisionAnswer: null,
    blockingIssues: [],
  };
}

/** The argv of one headless run. No shell shim, and the child receives only explicit flags. */
export function childArguments({ prepared, loop, workTree, transcript, maxSteps, resume }) {
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
    "--require-accept",
  ];
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
  if (resume.pr !== null && resume.pr !== undefined) {
    args.push("--pr", String(resume.pr), "--require-ci", String(resume.pr));
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

/** Spawns one headless run with stdout and stderr appended to `logPath`. */
export async function spawnHeadless({ args, cwd, logPath, deps = {} }) {
  if (deps.spawn) return deps.spawn({ args, cwd, logPath });
  const stream = createWriteStream(logPath, { flags: "a" });
  const subprocess = killTreeOnExit(
    execa(process.execPath, [cliPath(), ...args], {
      cwd,
      reject: false,
      stdin: "ignore",
      stdout: stream,
      stderr: stream,
      killDescendants: true,
    }),
  );
  const pid = subprocess.pid;
  const startTime = await processStartTime(pid);
  const done = subprocess
    .then((result) => ({ exitCode: result.exitCode ?? null }))
    .catch(() => ({ exitCode: null }));
  return {
    pid,
    startTime,
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
    close: () => stream.end(),
  };
}

const terminal = (status) => TERMINAL.has(status);

function loopEntry(loop) {
  return {
    issue: loop.issue,
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
  };
}

function summaryOf(manifest, loops) {
  return {
    batchId: manifest.id,
    status: manifest.status,
    loops: manifest.issues.map((issue) => loopEntry(loops.get(issue))),
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
 * Starts or resumes one batch. Returns `{ exitCode, summary }`. Every state write is a checkpoint
 * event; a quiet interval writes nothing.
 */
export async function runBatch({ prepared, runsRoot, gh, deps = {} }) {
  const paths = batchPaths(runsRoot);
  const id = prepared.id;
  let manifest;
  const loops = new Map();
  let start = true;

  if (prepared.resume) {
    manifest = await readManifest(runsRoot, id);
    if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
    start = false;
    for (const issue of manifest.issues) loops.set(issue, await readLoop(runsRoot, id, issue));
    const pending = manifest.issues.some((issue) => {
      const loop = loops.get(issue);
      return !terminal(loop.status) || (loop.status === "succeeded" && loop.cleanup === null);
    });
    if (!pending) {
      return { exitCode: exitCodeOf(manifest, loops), summary: summaryOf(manifest, loops) };
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
    manifest = {
      id,
      repo: prepared.repo,
      repoKey: prepared.repoKey,
      createdAt: new Date().toISOString(),
      base: prepared.base,
      workTreeRoot: prepared.workTreeRoot,
      issues: prepared.issues,
      status: "running",
      completionNotified: false,
      settings: {
        loops: prepared.loops,
        maxSteps: prepared.maxSteps,
        taskTemplate: prepared.taskTemplate,
        setupCmd: prepared.setupCmd,
        setupTimeout: prepared.setupTimeout,
        testCmd: prepared.testCmd,
        testCmdTimeout: prepared.testCmdTimeout,
        timeout: prepared.timeout,
        reviewerSandbox: prepared.reviewerSandbox,
        roles: prepared.roles,
      },
    };
    for (const issue of prepared.issues)
      loops.set(issue, queuedLoop(paths, id, issue, prepared.maxSteps));
    await createBatchStore(runsRoot, manifest, [...loops.values()]);
    progress(`batch ${id} started (${prepared.issues.length} issue(s), ${prepared.loops} loop(s))`);
  }

  const controller = new AbortController();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let interrupted = false;
  let hard = false;
  const active = new Map();
  const children = new Map();
  const lockSkipped = new Set();
  const waiting = new Set();
  let pausedReason = null;
  const notifier = deps.notifier ?? defaultNotify;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const clock = { now: deps.now ?? (() => performance.now()), sleep: deps.sleep ?? defaultSleep };

  const sendNotification = async (event) => {
    try {
      await notifier(event);
    } catch (err) {
      logWarn(`the notification failed: ${err?.message ?? err}`);
    }
  };

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
        controller.abort();
        forward("SIGINT");
      }
    });
  }

  const changeLoop = async (issue, patch) => {
    const next = await updateLoop(runsRoot, id, issue, (current) => ({ ...current, ...patch }));
    loops.set(issue, await readLoop(runsRoot, id, issue));
    return next;
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
    const branch = await gitRead(["rev-parse", "--abbrev-ref", "HEAD"], workTree.path);
    return branch.exitCode === 0 && branch.stdout === workTree.branch
      ? null
      : "the recorded branch is not checked out";
  };

  const optionKeysOf = (decision) =>
    (decision?.options ?? DECISION_OPTIONS).map((option) => option.key).join(", ");

  const markNeedsOwner = async (issue, reason, { evidence = null, extra = {} } = {}) => {
    const current = await readLoop(runsRoot, id, issue);
    const attempt = Number.isInteger(current?.attempts) ? current.attempts : 0;
    let decisionId = null;
    let created = false;
    if (typeof current?.decision === "string") {
      const existing = await readDecision(runsRoot, id, current.decision);
      if (
        existing !== null &&
        existing.ok &&
        existing.decision.reason === reason &&
        existing.decision.attempt === attempt
      ) {
        decisionId = current.decision;
      }
    }
    if (decisionId === null) {
      const idForState = newDecisionId(id, issue, attempt, reason);
      const result = await createDecision({
        runsRoot,
        batchId: id,
        id: idForState,
        issue,
        attempt,
        reason,
        evidence,
      });
      decisionId = result.decision.id;
      created = result.created;
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
    if (created) {
      logInfo(`issue ${issue}: decision ${decisionId} created (${reason})`);
      const read = await readDecision(runsRoot, id, decisionId);
      const decision = read?.ok ? read.decision : null;
      await sendNotification({
        kind: "decision",
        title: "Batch decision needed",
        text: `Batch ${id} issue ${issue} needs a decision: ${reason}. Options: ${optionKeysOf(decision)}. Recommended: ${decision?.recommended ?? RECOMMENDED_OPTION}. Answer: agent-loop batch answer --batch ${id} --decision ${decisionId} --option <key>`,
      });
    }
    return created;
  };

  const applyDecisionAnswer = async (issue, current) => {
    if (typeof current.decision !== "string") {
      await markNeedsOwner(issue, current.reason ?? "needs-owner", {
        evidence: current.reason ?? null,
      });
      return { kind: "pending" };
    }
    const decision = await readDecision(runsRoot, id, current.decision);
    if (decision === null || !decision.ok) {
      logWarn(
        `issue ${issue}: decision ${current.decision} is unreadable; the loop stays needs-owner`,
      );
      return { kind: "malformed" };
    }
    const answer = await readAnswer(runsRoot, id, current.decision);
    if (answer !== null && !answer.ok) {
      logWarn(
        `issue ${issue}: answer ${current.decision} is unreadable; the loop stays needs-owner`,
      );
      return { kind: "malformed" };
    }
    if (answer === null) return { kind: "pending" };
    const abandon = answer.answer.option === "abandon";
    await changeLoop(issue, {
      status: abandon ? "failed" : "queued",
      reason: abandon ? ABANDON_REASON : null,
      skipReason: null,
      decisionAnswer: answer.answer.option,
      pid: null,
      startTime: null,
    });
    if (abandon) {
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
      return { kind: "abandoned" };
    }
    return { kind: "resume", loop: await readLoop(runsRoot, id, issue) };
  };

  const launchIssue = async (issue, { recovery = null } = {}) => {
    let loop = loops.get(issue);
    if (recovery === null) {
      let closures;
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
      const claim = await readClaim(runsRoot, prepared.repoKey, issue);
      const eligibility = await checkEligibility({
        issue,
        gh,
        repo: prepared.repo,
        batchId: id,
        claim,
        openPrClosures: closures,
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
      let title = `issue ${issue}`;
      try {
        const reply = await gh(["issue", "view", String(issue), "--json", "title"], prepared.repo);
        if (reply?.status === 0) {
          const parsed = JSON.parse(reply.stdout);
          if (typeof parsed?.title === "string" && parsed.title.trim() !== "") title = parsed.title;
        }
      } catch {
        // A missing title keeps the issue number in the task.
      }
      const task = renderTask(prepared.taskTemplate, {
        issue,
        title,
        branch: loop.branch,
        repo: prepared.repo,
      });
      const workTreePath = join(prepared.workTreeRoot, `issue-${issue}`);
      const recordedWorkTree = loop.workTree;
      let workTree = recordedWorkTree;
      try {
        if (workTree === null || workTree === undefined) {
          workTree = await createLoopWorkTree({
            repo: prepared.repo,
            base: prepared.base,
            workTree: workTreePath,
            branch: loop.branch,
          });
        }
      } catch (err) {
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
      let freshRecovery = { continueFrom: null, pr: null };
      if (recordedWorkTree !== null && recordedWorkTree !== undefined) {
        const refused = await verifyRecordedWorkTree(loop);
        if (refused !== null) {
          await markNeedsOwner(issue, refused, { evidence: refused });
          return;
        }
        const decision = await reconcileLoop({
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
        if (decision.pr !== null) freshRecovery = { continueFrom: null, pr: decision.pr };
      }
      await changeLoop(issue, {
        workTree,
        task,
        status: "queued",
        setupDone: loop.setupDone === true,
        pr: freshRecovery.pr ?? loop.pr,
      });
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
          progress(`issue ${issue}: failed (setup-failed)`);
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
      await changeLoop(issue, {
        status: "failed",
        reason: `child-error: ${err.message}`,
      });
      await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
      logError(`issue ${issue}: failed (child-error: ${err.message})`);
      return;
    }
    children.set(issue, child);
    if (interrupted || hard) child.kill?.("SIGINT");
    await changeLoop(issue, { pid: child.pid ?? null, startTime: child.startTime ?? null });
    progress(`issue ${issue}: attempt ${attempt} started (pid ${child.pid ?? "unknown"})`);
    const promise = (async () => {
      const { exitCode } = await child.done;
      child.close?.();
      children.delete(issue);
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
      const cleanup = await cleanupLoop({
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
    await changeLoop(issue, {
      ...common,
      status: "failed",
      reason: `exit-${exitCode ?? "unknown"}`,
    });
    await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
    logError(`issue ${issue}: failed (exit ${exitCode ?? "unknown"})`);
    progress(`issue ${issue}: failed (exit ${exitCode ?? "unknown"})`);
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
    const cleanup = await cleanupLoop({ manifest, loop: updated, runsRoot, gh }).catch((err) => ({
      removed: false,
      reason: err.message,
    }));
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
    const lockFile = join(paths.batchDir(id), "loops", `issue-${issue}.resume.lock`);
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

  const recover = async (issue, initial) => {
    let loop = initial;
    if (loop.status === "needs-owner") {
      const applied = await applyDecisionAnswer(issue, loop);
      if (applied.kind !== "resume") return;
      loop = applied.loop;
    }
    if (isLive(loop)) {
      // A recorded live PID is never restarted. Without a readable identity the loop needs its
      // owner instead of waiting forever (ADR 0106 decision 10).
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
    }
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
    if (recordedExit.ok && recordedExit.proven && [1, 2, 4].includes(recordedExit.exitCode)) {
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
    const decision = await reconcileLoop({
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
      recovery: { continueFrom: loop.transcript, pr: decision.pr },
    });
  };

  // Fill the loop slots from the frozen set in order. A waiting issue is polled outside the queue.
  const remaining = new Set();
  for (const issue of manifest.issues) {
    const loop = loops.get(issue);
    if (loop.status === "waiting") waiting.add(issue);
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
      { signal: controller.signal },
    );
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
      logWarn(`issue ${issue}: the wait read failed: ${err.message}; retrying on the next poll`);
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
    logInfo(`issue ${issue}: blockers closed; queued for launch`);
    return "ready";
  };
  const canFill = () => active.size < prepared.loops;
  let pollLogged = false;
  for (;;) {
    while (!interrupted && !hard && pausedReason === null && canFill() && remaining.size > 0) {
      const issue = nextIssue();
      remaining.delete(issue);
      const runOne = async () => {
        const current = await readLoop(runsRoot, id, issue);
        if (!start && current.status === "succeeded" && current.cleanup === null) {
          const cleanup = await cleanupLoop({ manifest, loop: current, runsRoot, gh }).catch(
            (err) => ({ removed: false, reason: err.message }),
          );
          await changeLoop(issue, { cleanup });
          await releaseClaim(runsRoot, prepared.repoKey, issue, { batchId: id });
          return;
        }
        if (terminal(current.status)) return;
        if (!start) {
          // A resume reconciles one recovered loop before it launches, so it never restarts
          // blindly. A recorded transcript is a lost record, not a fresh launch.
          const hasTranscript =
            current.status !== "queued" ||
            (await stat(current.transcript).then(
              () => true,
              () => false,
            ));
          if (hasTranscript) {
            await recover(issue, current);
            return;
          }
        }
        try {
          await launchIssue(issue);
        } catch (err) {
          if (!err?.batchWide) throw err;
        }
      };
      if (start) await runOne();
      else await withLoopOwnership(issue, runOne);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (hard || interrupted) break;
    if (active.size > 0) {
      await Promise.race(active.values());
      continue;
    }
    if (pausedReason !== null) break;
    if (waiting.size === 0) break;
    if (!pollLogged) {
      pollLogged = true;
      logInfo(`waiting poll started for issue(s) ${[...waiting].join(", ")}`);
    }
    await pollWait(pollIntervalMs, controller.signal, clock);
    if (interrupted || hard) break;
    for (const issue of waiting) {
      const result = await recheckWaiting(issue);
      if (result === "done") waiting.delete(issue);
      else if (result === "ready") {
        waiting.delete(issue);
        remaining.add(issue);
      }
    }
    if (waiting.size === 0 && pollLogged) {
      pollLogged = false;
      logInfo("waiting poll stopped");
    }
  }
  if (pollLogged) logInfo("waiting poll stopped");
  // A resume runs its recovered loops one at a time; this drains any that the pass left live.
  while (active.size > 0 && !hard) await Promise.race(active.values());

  if (installSignal) process.removeListener("SIGINT", onSigInt);

  let status;
  if (interrupted) status = "interrupted";
  else if (pausedReason !== null) status = "paused";
  else if ([...loops.values()].some((loop) => ["waiting", "needs-owner"].includes(loop.status))) {
    status = "waiting";
  } else if ([...loops.values()].some((loop) => loop.status === "failed")) {
    status = "failed";
  } else if (
    lockSkipped.size > 0 ||
    [...loops.values()].some((loop) => loop.status === "running")
  ) {
    status = "paused";
    pausedReason ??= "a loop is owned by another resume";
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
  return { exitCode: exitCodeOf(manifest, loops), summary: summaryOf(manifest, loops) };
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
  const answer = await readAnswer(runsRoot, batchId, loop.decision);
  if (answer !== null && !answer.ok) {
    return { ...view, state: "malformed", error: answer.reason };
  }
  if (answer !== null) {
    return { ...view, state: "answered", answer: { option: answer.answer.option } };
  }
  return view;
}

/** Reads one batch for `batch status`; a live-owner checkpoint that is gone reads `stale`. */
export async function readBatchStatus({ runsRoot, id }) {
  const manifest = await readManifest(runsRoot, id);
  if (manifest === null) throw Object.assign(new Error(`No batch ${id}.`), { usage: true });
  const loops = [];
  for (const issue of manifest.issues) {
    const loop = await readLoop(runsRoot, id, issue);
    if (loop === null) continue;
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
    } else loops.push({ ...loopEntry(loop), ...waitDetails, nextAction: null });
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
