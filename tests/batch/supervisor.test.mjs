import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { prepareBatch } from "../../src/batch/args.mjs";
import { git } from "../../src/batch/git.mjs";
import { tryStateLock } from "../../src/lib/state-lock.mjs";
import { endSubprocessTree } from "../../src/lib/exec-tree.mjs";
import { pidAlive } from "../../src/lib/process-identity.mjs";
import {
  batchPaths,
  readLoop,
  readManifest,
  updateLoop,
  updateManifest,
} from "../../src/batch/store.mjs";
import {
  UNVERIFIED_STEPS_OPTIONS,
  answerDecision,
  createDecision,
  newDecisionId,
  readDecision,
} from "../../src/batch/decisions.mjs";
import {
  childArguments,
  newBatchId,
  readBatchStatus,
  runBatch,
  runSetup,
  spawnHeadless,
} from "../../src/batch/supervisor.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

const BODY = ["## Problem", "Missing.", "", "## Acceptance", "", "- one check", ""].join("\n");
const SUMMARY = {
  changed: "a",
  verified: "b",
  deferred: "c",
  notDone: "d",
  open: "e",
  notes: "a note",
};

function fakeGh({ blocked = [], closed = new Set(), pulls = [] } = {}) {
  return async (args) => {
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: blocked } }), stderr: "" };
      }
      if (args.includes("body")) {
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      }
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "An issue title" }), stderr: "" };
      }
      if (args.includes("closedByPullRequestsReferences")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: closed.size === 0 ? "OPEN" : "CLOSED",
            closedByPullRequestsReferences: [],
          }),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ state: closed.has(Number(args[2])) ? "CLOSED" : "OPEN" }),
        stderr: "",
      };
    }
    if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
      return { status: 0, stdout: JSON.stringify(pulls), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

// A test never shows a desktop notification. A case that reads notifications passes its own.
const noNotify = async () => ({ spawned: false, ok: true });

// The new wait and decision cases model the work tree and the gates in process.
// No case starts a Git process after the one shared preparation.
const fakeGitDeps = {
  createWorkTree: async ({ workTree, branch }) => ({
    path: workTree,
    canonicalPath: workTree,
    dev: "1",
    ino: "1",
    branch,
  }),
  verifyWorkTree: async () => null,
  reconcileLoop: async () => ({ status: "resume", reason: null, pr: null, requireCi: null }),
  cleanupLoop: async () => ({ removed: false, reason: "test" }),
};

/**
 * A child double that records its arguments and writes a transcript. `hold` keeps each run live
 * until the test releases it. `call.written` settles when the first transcript write finishes.
 */
function childDouble({
  exitCode = 0,
  steps = 0,
  roles = {},
  hold = false,
  pr = null,
  summary = null,
  error = null,
  warnings = [],
  failedTurnTest = null,
  beforeWrite = null,
} = {}) {
  const calls = [];
  const pending = [];
  const spawn = async ({ args, cwd, logPath }) => {
    const transcript = valueAfter(args, "--transcript");
    const gate = hold ? deferred() : null;
    const written = deferred();
    const call = {
      args,
      cwd,
      logPath,
      transcript,
      maxSteps: valueAfter(args, "--max-steps"),
      gate,
      written: written.promise,
    };
    calls.push(call);
    // The gate is reachable in the same step as its call, before any awaited transcript write.
    if (gate) pending.push(gate);
    let earlier = { events: [] };
    if (args.includes("--continue-from")) {
      earlier = JSON.parse(await readFile(transcript, "utf8"));
    }
    const nextEvents =
      steps > 0
        ? [
            { type: "action", action: { action: "run_worker" }, stepsUsed: 0 },
            { type: "result", role: "worker", stepsUsed: steps },
          ]
        : [];
    if (beforeWrite) await beforeWrite();
    await writeFile(
      transcript,
      JSON.stringify({
        roles,
        events: [
          ...earlier.events,
          ...(args.includes("--continue-from") ? [{ type: "continued", exitCode: 130 }] : []),
          ...nextEvents,
          ...(pr === null ? [] : [{ type: "pr-declared", pr }]),
          ...(summary === null ? [] : [{ type: "action", action: { action: "finish", summary } }]),
          ...(failedTurnTest === null
            ? []
            : [{ type: "test-run", fatal: true, testRun: failedTurnTest }]),
          { type: "gate" },
        ],
        exitCode,
        error,
        warnings,
      }),
    );
    written.resolve();
    const done = gate ? gate.promise : Promise.resolve({ exitCode });
    const stop = async () => {
      if (gate) {
        const data = JSON.parse(await readFile(transcript, "utf8"));
        await writeFile(transcript, JSON.stringify({ ...data, exitCode: 130 }));
        gate.resolve({ exitCode: 130 });
      }
    };
    return {
      pid: process.pid,
      startTime: null,
      done,
      kill: () => void stop(),
      hardKill: () => void stop(),
      close: () => {},
    };
  };
  return { spawn, calls, pending };
}

// One immutable repository and bare remote for the file. Each case gets its own work-tree root
// and batch id, so mutable state is per test and no case runs git init or an initial push.
const roots = [];
let sharedRepo;
async function batchRepo() {
  if (sharedRepo) return sharedRepo;
  const main = await createTempRepo();
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  const remote = await mkdtemp(join(tmpdir(), "batch-it-remote-"));
  await execa("git", ["init", "--bare"], { cwd: remote });
  await execa("git", ["remote", "add", "origin", remote], { cwd: main });
  await execa("git", ["push", "-u", "origin", base], { cwd: main });
  await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
  await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`], {
    cwd: main,
  });
  sharedRepo = { main, remote, base };
  return sharedRepo;
}

afterAll(async () => {
  for (const root of roots.splice(0)) await removePath(root);
  if (sharedRepo) {
    await removePath(sharedRepo.remote);
    await removePath(sharedRepo.main);
    sharedRepo = undefined;
  }
});

async function preparedFor({ main, base }, issues, overrides = {}) {
  const id = overrides.id ?? newBatchId();
  const root = await mkdtemp(join(tmpdir(), "batch-it-root-"));
  roots.push(root);
  return prepareBatch({
    id,
    repo: main,
    issues,
    base,
    workTreeRoot: root,
    loops: issues.length,
    maxSteps: 10,
    setupCmd: null,
    setupTimeout: 600,
    taskTemplate: "Work {issue} {title} on {branch} in {repo}",
    timeout: 3600,
    reviewerSandbox: null,
    orchestrator: "codex",
    worker: "claude",
    reviewer: "agy",
    orchestratorModel: null,
    workerModel: null,
    reviewerModel: null,
    orchestratorEffort: null,
    workerEffort: null,
    reviewerEffort: null,
    ...overrides,
  });
}

async function pushLoop(prepared, issue = 1) {
  const workTree = join(prepared.workTreeRoot, `issue-${issue}`);
  const branch = `batch/${prepared.id}/${issue}`;
  await execa("git", ["push", "-u", "origin", branch], { cwd: workTree });
}

// The shared repository and remote are removed once for the file. Each case removes only the
// work-tree root it created, at `afterAll`, so no case depends on another case's teardown.
async function cleanupRepo() {}

// Usefulness: the real headless child writes its output to the log file (the one end-to-end run of this entry point).
test("the real headless child writes its output to the log file", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-spawn-"));
  const logPath = join(root, "child.log");
  try {
    await writeFile(logPath, "batch-spawn-earlier\n");
    const child = await spawnHeadless({ args: ["--help"], cwd: root, logPath });
    const { exitCode } = await child.done;
    expect(exitCode).toBe(0);
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("batch-spawn-earlier\n");
    expect(log).toContain("Usage:");
  } finally {
    await removePath(root);
  }
});

// Usefulness: a real spawn failure fails the loop with its code and no started line.
test("a real spawn failure fails the loop with its code and no started line", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const missing = join(prepared.workTreeRoot, "missing-cwd");
  const lines = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        installSignal: false,
        createWorkTree: async ({ branch }) => ({
          path: missing,
          canonicalPath: missing,
          dev: "1",
          ino: "1",
          branch,
        }),
      },
    });
    expect(exitCode).toBe(1);
    const reason = summary.loops[0].reason;
    expect(summary.loops[0].status).toBe("failed");
    expect(reason).toMatch(/^child-error: .*ENOENT/);
    expect(reason).toContain("spawn");
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("--orchestrator");
    expect(lines.some((line) => line.includes("started (pid"))).toBe(false);
    const claim = batchPaths(join(prepared.workTreeRoot, "runs")).claim(prepared.repoKey, 1);
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    spy.mockRestore();
    await cleanupRepo(repo);
  }
});

describe("bounded batch reads", () => {
  let prepared;
  beforeAll(async () => {
    prepared = await preparedFor(await batchRepo(), [1]);
  });

  const runsRootFor = (name) => join(prepared.workTreeRoot, `runs-${name}`);
  const replyOnAbort =
    (reply) =>
    (args, cwd, options = {}) =>
      new Promise((resolve) => {
        const end = () => resolve(reply);
        if (options.signal?.aborted) end();
        else options.signal?.addEventListener("abort", end, { once: true });
      });

  // Usefulness: a gh read that never returns ends at the bound, so the batch cannot hang.
  test("a gh read that never returns ends at the bound", async () => {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("bound"),
      gh: replyOnAbort({ status: null, stdout: "", stderr: "", timedOut: true }),
      deps: { notifier: noNotify, installSignal: false, ghTimeoutMs: 20 },
    });
    expect(exitCode).toBe(0);
    expect(summary.loops[0].skipReason).toBe("eligibility-unverified");
    expect(summary.loops[0].reason).toContain("timed out after 20ms");
  });

  // Usefulness: a refused preflight removes its SIGINT and abort listeners.
  test("a refused preflight removes its listeners", async () => {
    const signal = new AbortController().signal;
    const before = process.listenerCount("SIGINT");
    const { exitCode } = await runBatch({
      prepared,
      runsRoot: runsRootFor("listeners-refused"),
      gh: replyOnAbort({ status: null, stdout: "", stderr: "", timedOut: true }),
      deps: { notifier: noNotify, ghTimeoutMs: 20, signal },
    });
    expect(exitCode).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  // Usefulness: an already-aborted run signal ends the batch interrupted with exit 130.
  test("an already-aborted run signal ends the batch interrupted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stopped before preflight"));
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("aborted-before"),
      gh: replyOnAbort({ status: 0, stdout: JSON.stringify({ number: 1 }), stderr: "" }),
      deps: { notifier: noNotify, installSignal: false, signal: abort.signal },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
  });

  // Usefulness: an abort during a hung preflight read ends interrupted with exit 130.
  test("an abort during a hung preflight read ends interrupted", async () => {
    const abort = new AbortController();
    const before = process.listenerCount("SIGINT");
    let started = false;
    const gh = (args, cwd, options = {}) => {
      if (!started) {
        started = true;
        setTimeout(() => abort.abort(new Error("stopped in preflight")), 10);
      }
      return replyOnAbort({ status: 0, stdout: JSON.stringify({ number: 1 }), stderr: "" })(
        args,
        cwd,
        options,
      );
    };
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: runsRootFor("aborted-during"),
      gh,
      deps: { notifier: noNotify, signal: abort.signal, ghTimeoutMs: 60_000 },
    });
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  // Usefulness: a fetch failure removes the SIGINT and abort listeners before it rejects.
  test("a preflight throw removes its listeners", async () => {
    const signal = new AbortController().signal;
    const before = process.listenerCount("SIGINT");
    const head = "a".repeat(40);
    const item = {
      kind: "pr",
      number: 7,
      key: "pr-7",
      mode: "review-first",
      task: null,
      head,
      headRefName: "pr-7",
      foreign: false,
    };
    const gh = async (args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: head,
            headRefName: "pr-7",
            isCrossRepository: false,
          }),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    await expect(
      runBatch({
        prepared,
        runsRoot: runsRootFor("fetch-throw"),
        gh,
        deps: {
          notifier: noNotify,
          signal,
          freezeItems: async () => [item],
          planPrWorkTree: async () => {
            throw new Error("the git fetch failed");
          },
        },
      }),
    ).rejects.toThrow("the git fetch failed");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  // Usefulness: a throw with a live child stops and drains it before the listeners are removed.
  test("a throw with a live child drains it first", async () => {
    const two = { ...prepared, id: newBatchId(), issues: [1, 2], loops: 2 };
    const runsRoot = join(prepared.workTreeRoot, `runs-${two.id}`);
    await runBatch({
      prepared: two,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const recorded = {
      path: join(prepared.workTreeRoot, "issue-2"),
      canonicalPath: join(prepared.workTreeRoot, "issue-2"),
      dev: "1",
      ino: "1",
      branch: `batch/${two.id}/2`,
    };
    for (const issue of [1, 2]) {
      await removePath(batchPaths(runsRoot).transcript(two.id, issue));
      await updateLoop(runsRoot, two.id, issue, (loop) => ({
        ...loop,
        status: "queued",
        attempts: 0,
        pid: null,
        startTime: null,
        workTree: issue === 2 ? recorded : null,
        cleanup: null,
      }));
    }
    const child = childDouble({ hold: true });
    const stops = [];
    const spawn = async (options) => {
      const started = await child.spawn(options);
      return {
        ...started,
        kill: (signal) => {
          stops.push(signal);
          started.kill(signal);
        },
      };
    };
    const signal = new AbortController().signal;
    const before = process.listenerCount("SIGINT");
    const run = runBatch({
      prepared: { ...two, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        signal,
        reconcileLoop: async () => {
          throw new Error("the git fetch failed");
        },
      },
    });
    await expect(run).rejects.toThrow("the git fetch failed");
    expect(stops).toContain("SIGINT");
    expect((await readLoop(runsRoot, two.id, 1)).status).toBe("interrupted");
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });
});

// Usefulness: three issues get three work trees, three branches, and one child each.
test("three selected issues create three work trees and one child each", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1, 2, 3]);
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    expect(summary.loops).toHaveLength(3);
    expect(new Set(child.calls.map((call) => call.cwd)).size).toBe(3);
    for (const call of child.calls) {
      expect(call.cwd).toContain("issue-");
      expect(call.maxSteps).toBe("10");
      expect((await stat(call.transcript)).isFile()).toBe(true);
      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], call.cwd)).stdout;
      expect(branch).toBe(`batch/${prepared.id}/${call.cwd.split("issue-")[1]}`);
    }
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: the loop limit bounds live children, and a freed slot starts the next issue.
test("the loop limit bounds live children and a freed slot starts the next issue", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1, 2, 3], { loops: 2 });
  const child = childDouble({ hold: true });
  let live = 0;
  let peak = 0;
  const spawn = async (options) => {
    live += 1;
    peak = Math.max(peak, live);
    const spawned = await child.spawn(options);
    return {
      ...spawned,
      done: spawned.done.finally(() => {
        live -= 1;
      }),
    };
  };
  try {
    const run = runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn, installSignal: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(child.calls.length).toBe(2);
    child.pending[0].resolve({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(child.calls.length).toBe(3);
    expect(peak).toBeLessThanOrEqual(2);
    child.pending[1].resolve({ exitCode: 0 });
    child.pending[2].resolve({ exitCode: 0 });
    const { exitCode } = await run;
    expect(exitCode).toBe(0);
    expect(peak).toBe(2);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a running batch's claim makes a second batch skip the issue instead of duplicating it.
test("two batches for one issue produce one launch and one claimed skip", async () => {
  const repo = await batchRepo();
  const first = await preparedFor(repo, [1]);
  const second = await preparedFor(repo, [1]);
  const child = childDouble({ hold: true });
  try {
    const runsRoot = join(first.workTreeRoot, "runs");
    const runA = runBatch({
      prepared: first,
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(child.calls).toHaveLength(1);
    const childB = childDouble();
    const runB = await runBatch({
      prepared: second,
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: childB.spawn, installSignal: false },
    });
    expect(childB.calls).toHaveLength(0);
    expect(runB.summary.loops[0]).toMatchObject({ status: "skipped", skipReason: "claimed" });
    child.pending[0].resolve({ exitCode: 0 });
    await runA;
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: failure isolation leaves a successful loop successful and does not retry the failure.
test("a failed loop does not stop or retry another loop", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1, 2]);
  const results = [2, 0];
  let index = 0;
  const child = childDouble();
  const spawn = async (options) => {
    const result = results[index++] === 2 ? 2 : 0;
    const spawned = await child.spawn(options);
    return { ...spawned, done: Promise.resolve({ exitCode: result }) };
  };
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn, installSignal: false },
    });
    expect(exitCode).toBe(1);
    expect(summary.status).toBe("failed");
    expect(summary.loops.map((loop) => loop.status)).toEqual(["failed", "succeeded"]);
    expect(summary.loops[0].reason).toBe("exit-2");
    expect(child.calls).toHaveLength(2);
    const loops = join(prepared.workTreeRoot, "runs", "batches", prepared.id, "loops");
    expect((await stat(loops)).isDirectory()).toBe(true);
    const claim = batchPaths(join(prepared.workTreeRoot, "runs")).claim(prepared.repoKey, 1);
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: SIGINT stops launches, marks each unfinished loop interrupted, keeps the work tree
// and claim, and exits 130.
test("SIGINT marks unfinished loops interrupted and exits 130", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(child.calls).toHaveLength(1);
    controller.abort();
    const { exitCode, summary } = await run;
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(summary.loops[0].status).toBe("interrupted");
    expect((await stat(summary.loops[0].workTree)).isDirectory()).toBe(true);
    const claim = batchPaths(join(prepared.workTreeRoot, "runs")).claim(prepared.repoKey, 1);
    expect((await stat(claim)).isFile()).toBe(true);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a resume spends only the remaining budget on the same transcript.
test("a resume with 3 of 10 steps spent passes --max-steps 7 and the same transcript", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const first = child.calls[0];
    expect(first.maxSteps).toBe("10");
    await pushLoop(prepared);

    const childResume = childDouble({ steps: 2 });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: childResume.spawn, installSignal: false },
    });
    expect(childResume.calls).toHaveLength(1);
    expect(childResume.calls[0].transcript).toBe(first.transcript);
    expect(childResume.calls[0].maxSteps).toBe("7");
    expect(childResume.calls[0].args).toContain("--continue-from");
    expect(resumed.summary.loops[0].stepsUsed).toBe(5);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a status read changes no checkpoint mtime and reports a dead owner as stale.
test("a status read writes nothing and reports a dead owner as stale", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const file = batchPaths(runsRoot).loop(prepared.id, 1);
    const before = await stat(file, { bigint: true });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    const after = await stat(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(status.loops[0].status).toBe("interrupted");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: an issue outside the frozen set is never launched, and the manifest keeps the set.
test("the selected set is frozen at start", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1, 2]);
  const child = childDouble();
  try {
    const runsRoot = join(prepared.workTreeRoot, "runs");
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(2);
    const manifest = await readManifest(runsRoot, prepared.id);
    expect(manifest.issues).toEqual([1, 2]);
    expect(child.calls.some((call) => call.cwd.endsWith("issue-3"))).toBe(false);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a skip is recorded with its reason and creates no child.
test("a closed issue is skipped with its reason and no child", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const child = childDouble();
  try {
    const runsRoot = join(prepared.workTreeRoot, "runs");
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([1]) }),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(summary.loops[0]).toMatchObject({ status: "skipped", skipReason: "closed" });
    expect(await readLoop(runsRoot, prepared.id, 1)).toMatchObject({
      status: "skipped",
      skipReason: "closed",
    });
    expect(await readFile(batchPaths(runsRoot).manifest(prepared.id), "utf8")).toContain(
      '"issues"',
    );
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a resume with no pending work creates no child, claim, or checkpoint write.
test("a resume with no pending work writes nothing", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble();
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    const checkpoint = batchPaths(runsRoot).loop(prepared.id, 1);
    const manifestFile = batchPaths(runsRoot).manifest(prepared.id);
    const beforeLoop = await stat(checkpoint, { bigint: true });
    const beforeManifest = await stat(manifestFile, { bigint: true });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(1);
    expect(resumed.exitCode).toBe(0);
    expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(beforeLoop.mtimeNs);
    expect((await stat(manifestFile, { bigint: true })).mtimeNs).toBe(beforeManifest.mtimeNs);
    await expect(stat(batchPaths(runsRoot).claim(prepared.repoKey, 1))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a configured zero timeout reaches the child as --timeout 0, not the 3600 s default.
test("a zero timeout is passed to the child", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1], { timeout: null });
  try {
    const args = childArguments({
      prepared,
      loop: { issue: 1, task: "Work", remainingSteps: 10 },
      workTree: prepared.workTreeRoot,
      transcript: "run.json",
      maxSteps: 10,
      resume: { continueFrom: null, pr: null },
    });
    const index = args.indexOf("--timeout");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("0");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: an answered decision resumes the loop after the owner resolves the state.
test("an answered decision resumes the loop after the owner resolves the state", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await pushLoop(prepared);
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "a resolved state",
      pid: null,
      startTime: null,
    }));

    const pendingChild = childDouble();
    const pending = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: pendingChild.spawn, installSignal: false },
    });
    expect(pendingChild.calls).toHaveLength(0);
    expect(pending.exitCode).toBe(1);
    expect(pending.summary.status).toBe("waiting");
    const pendingLoop = await readLoop(runsRoot, prepared.id, 1);
    expect(pendingLoop.status).toBe("needs-owner");
    expect((await readDecision(runsRoot, prepared.id, pendingLoop.decision)).ok).toBe(true);

    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: pendingLoop.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);

    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(1);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a recorded transcript exit 0 is a success and is never restarted.
test("a transcript that exited 0 is not restarted on recovery", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 0 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a recorded transcript exit 2 is a failure and is never restarted.
test("a transcript that exited 2 is not retried on recovery", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 2 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-2" });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a normal exit 4 stops needs-owner, keeps its claim and work tree, and records the PR.
test("a child that exits 4 stops needs-owner on the normal path", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ exitCode: 4, pr: 42 });
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
      },
    });
    expect(exitCode).toBe(1);
    expect(summary.loops[0]).toMatchObject({
      status: "needs-owner",
      reason: "pr-head-unresolved",
      pr: 42,
    });
    expect(summary.loops[0].workTree).toBe(join(prepared.workTreeRoot, "issue-1"));
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    expect((await stat(claim)).isFile()).toBe(true);
    const loop = await readLoop(runsRoot, prepared.id, 1);
    const decision = await readDecision(runsRoot, prepared.id, loop.decision);
    expect(decision.ok).toBe(true);
    expect(decision.decision.options.map((option) => option.key)).toEqual(["resume", "abandon"]);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an exit 4 loop keeps its finish summary and warnings on the normal path.
test("an exit 4 loop keeps its report on the normal path", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({
    exitCode: 4,
    pr: 42,
    summary: SUMMARY,
    warnings: ["delete by hand: old branch"],
  });
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0].report).toMatchObject({
      state: "read",
      summary: SUMMARY,
      warnings: ["delete by hand: old branch"],
      transcriptRead: { ok: true },
    });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: batch status names the pull request and the next action of an exit 4 loop.
test("batch status names the pull request and the next action", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 4, pr: 77 }).spawn,
        installSignal: false,
      },
    });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "needs-owner", pr: 77 });
    expect(status.loops[0].nextAction).toContain("pull request 77");
    expect(status.loops[0].nextAction).toContain("merge or resume");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: status names the branch and the missing pull request number when none is recorded.
test("batch status names the branch when no pull request is recorded", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 4 }).spawn,
        installSignal: false,
      },
    });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({
      status: "needs-owner",
      reason: "pr-head-unresolved",
      pr: null,
    });
    expect(status.loops[0].nextAction).toContain(`branch ${status.loops[0].branch}`);
    expect(status.loops[0].nextAction).toContain("not recorded");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a child that exits 1 stays failed on the normal path.
test("a child that exits 1 is failed on the normal path", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 1 }).spawn,
        installSignal: false,
      },
    });
    expect(exitCode).toBe(1);
    expect(summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-1" });
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a proven transcript exit 4 stops needs-owner on recovery and reuses its decision.
test("a transcript that exited 4 stops needs-owner on recovery", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 3, hold: true, pr: 42 });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 4 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
      },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.loops[0]).toMatchObject({
      status: "needs-owner",
      reason: "pr-head-unresolved",
      pr: 42,
    });
    expect(resumed.summary.loops[0].workTree).toBe(join(prepared.workTreeRoot, "issue-1"));
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    expect((await stat(claim)).isFile()).toBe(true);
    const loop = await readLoop(runsRoot, prepared.id, 1);
    const checkpoint = batchPaths(runsRoot).loop(prepared.id, 1);
    const before = await stat(checkpoint, { bigint: true });
    const again = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
      },
    });
    const after = await readLoop(runsRoot, prepared.id, 1);
    expect(again.exitCode).toBe(1);
    expect(after.decision).toBe(loop.decision);
    expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an exit 4 loop keeps its finish summary and warnings on recovery.
test("an exit 4 loop keeps its report on recovery", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({
    steps: 3,
    hold: true,
    pr: 42,
    summary: SUMMARY,
    warnings: ["delete by hand: old branch"],
  });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 4 }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
      },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].report).toMatchObject({
      state: "read",
      summary: SUMMARY,
      warnings: ["delete by hand: old branch"],
      transcriptRead: { ok: true },
    });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: two simultaneous resumes launch one loop once.
test("two simultaneous resumes launch a loop once", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await pushLoop(prepared);
    const resumeChild = childDouble({ hold: true });
    const a = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    const b = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(resumeChild.calls).toHaveLength(1);
    resumeChild.pending[0]?.resolve({ exitCode: 0 });
    await Promise.all([a, b]);
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a live recorded PID with no start stamp is never restarted.
test("a live recorded process with no start stamp is not restarted", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  const live = execa(process.execPath, ["-e", "setTimeout(() => {}, 8000)"]);
  live.catch(() => {});
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "running",
      pid: live.pid,
      startTime: null,
    }));
    const resumeChild = childDouble();
    const resumeController = new AbortController();
    const resumed = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: resumeChild.spawn,
        installSignal: false,
        signal: resumeController.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    resumeController.abort();
    const first = await resumed;
    expect(resumeChild.calls).toHaveLength(0);
    expect(first.summary.loops[0].status).toBe("needs-owner");
    expect((await readLoop(runsRoot, prepared.id, 1)).pid).toBe(live.pid);
    const secondChild = childDouble();
    const second = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: secondChild.spawn, installSignal: false },
    });
    expect(secondChild.calls).toHaveLength(0);
    expect(second.summary.loops[0].status).toBe("needs-owner");
  } finally {
    live.kill("SIGKILL");
    await cleanupRepo(repo);
  }
});

// Usefulness: an interrupted setup stops promptly and runs no child.
test("an aborted setup returns without waiting for the timeout", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const run = runSetup({
    command: "setup",
    workTree: process.cwd(),
    timeoutSeconds: 60,
    signal: controller.signal,
    deps: {
      notifier: noNotify,
      execBounded: async (file, args, options) => {
        await new Promise((resolve) => {
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        return { exitCode: 130 };
      },
    },
  });
  setTimeout(() => controller.abort(), 20);
  const ok = await run;
  expect(ok).toBe(false);
  expect(Date.now() - started).toBeLessThan(2000);
});

// Usefulness: a PR declared by the earlier transcript is imported before recovery, so the resumed
// attempt passes --pr and --require-ci for it.
test("a transcript PR declaration reaches the resumed attempt", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await pushLoop(prepared);
    const workTree = join(prepared.workTreeRoot, "issue-1");
    const head = (await git(["rev-parse", "HEAD"], workTree)).stdout;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(
      transcript,
      JSON.stringify({
        ...data,
        exitCode: 130,
        options: { pr: null, requireCi: null },
        events: [...data.events, { type: "pr-declared", pr: 5, stepsUsed: 0 }],
      }),
    );
    const pull = {
      number: 5,
      state: "OPEN",
      headRefOid: head,
      isCrossRepository: false,
      baseRefName: prepared.base,
    };
    const gh = (args) => {
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
        return { status: 0, stdout: JSON.stringify([pull]), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", headRefOid: head, mergeCommit: null }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", closedByPullRequestsReferences: [] }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    };
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh,
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(1);
    const args = resumeChild.calls[0].args;
    expect(args[args.indexOf("--pr") + 1]).toBe("5");
    expect(args[args.indexOf("--require-ci") + 1]).toBe("5");
    expect(resumed.summary.loops[0].pr).toBe(5);
  } finally {
    await cleanupRepo(repo);
  }
});

// Process-level exception: a forced kill must end a descendant that inherited the group, so it
// needs its own real process tree. Comment: this is the only case in this file that spawns a
// process tree outside the child double.
test("a forced kill ends the child process tree", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    "process.stdout.write(String(child.pid));",
    "setTimeout(() => {}, 60000);",
  ].join(" ");
  const subprocess = execa(process.execPath, ["-e", script], {
    killDescendants: true,
    stdout: "pipe",
  });
  subprocess.catch(() => {});
  const pid = await new Promise((resolve, reject) => {
    subprocess.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    subprocess.catch(reject);
  });
  expect(Number.isInteger(pid)).toBe(true);
  endSubprocessTree(subprocess);
  for (let attempt = 0; attempt < 20 && pidAlive(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(pidAlive(pid)).toBe(false);
});

// Usefulness: a lost checkpoint that says queued does not restart a child whose transcript
// already recorded exit 0.
test("a queued checkpoint does not restart a proven transcript", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble();
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "queued",
      cleanup: null,
    }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a fatal exit with no gate event is still a recorded attempt and is never retried.
test("a fatal exit without a gate event is not retried", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ steps: 1, hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const transcript = child.calls[0].transcript;
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(
      transcript,
      JSON.stringify({
        ...data,
        exitCode: 1,
        error: "detected a mutation",
        events: data.events.filter((event) => event.type !== "gate"),
      }),
    );
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-1" });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a pending decision frees its only slot, so the next issue launches behind it.
test("a pending decision frees its only slot and the next issue launches", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1, 2], { loops: 1 });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the remote state",
      pid: null,
      startTime: null,
    }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(1);
    expect(resumeChild.calls[0].cwd).toContain("issue-2");
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
    expect(resumed.summary.loops[0].decision).toBeTruthy();
    expect(resumed.summary.loops[1].status).toBe("succeeded");
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a resume that loses the ownership lock never reports a running loop as complete.
test("a loop owned by another resume is not reported complete", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  let release;
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-1.resume.lock");
    release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("paused");
  } finally {
    await release?.();
    await cleanupRepo(repo);
  }
});

// Usefulness: a held lock reports paused even when the skipped loop keeps a needs-owner checkpoint.
test("a needs-owner loop owned by another resume reports paused", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  let release;
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { spawn: child.spawn, installSignal: false, signal: controller.signal },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the remote state",
      pid: null,
      startTime: null,
    }));
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-1.resume.lock");
    release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("paused");
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
  } finally {
    await release?.();
    await cleanupRepo(repo);
  }
});

// Usefulness: a queued checkpoint trusts no replaced work tree; it stops as needs-owner.
test("a queued checkpoint with a replaced work tree stops before launch", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    controller.abort();
    await run;
    const workTree = join(prepared.workTreeRoot, "issue-1");
    const transcript = child.calls[0].transcript;
    await removePath(workTree);
    await mkdir(workTree);
    await removePath(transcript);
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "queued",
      setupDone: true,
      pid: null,
      startTime: null,
    }));
    const resumeChild = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
    });
    expect(resumeChild.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
  } finally {
    await cleanupRepo(repo);
  }
});

// One prepared repository serves the new wait cases. Each case gets its own work-tree root.
let sharedWait;
async function waitPrepared(issues, overrides = {}) {
  if (!sharedWait) {
    const repo = await batchRepo();
    sharedWait = await preparedFor(repo, [1]);
  }
  const id = newBatchId();
  return {
    ...sharedWait,
    id,
    issues,
    loops: overrides.loops ?? issues.length,
    workTreeRoot: join(sharedWait.workTreeRoot, `case-${id}`),
    ...overrides,
  };
}

// Usefulness: a blocked issue waits on the monotonic poll and launches after its blockers close.
test("a blocked issue waits on the poll and launches after its blockers close", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let blockedReads = 0;
  let polls = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        const open = blockedReads <= 2 ? [{ number: 9, state: "OPEN" }] : [];
        if (args.includes("state,blockedBy")) {
          polls += 1;
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open } }),
            stderr: "",
          };
        }
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(child.calls).toHaveLength(1);
    expect(exitCode).toBe(0);
    expect(summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a failed poll read warns, launches nothing, and retries on the next poll.
test("a failed poll read retries on the next poll", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let waitReads = 0;
  let blockedReads = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        waitReads += 1;
        if (waitReads === 1) return { status: 1, timedOut: true, stdout: "", stderr: "" };
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        const open = blockedReads === 1 ? [{ number: 9, state: "OPEN" }] : [];
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(waitReads).toBeGreaterThanOrEqual(2);
    expect(child.calls).toHaveLength(1);
    expect(summary.loops[0].status).toBe("succeeded");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an issue closed while it waits is reported as skipped and launches no child.
test("a closed issue while waiting is skipped and not launched", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  let blockedReads = 0;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "CLOSED", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        blockedReads += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  let now = 0;
  const child = childDouble();
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(child.calls).toHaveLength(0);
    expect(exitCode).toBe(0);
    expect(summary.loops[0]).toMatchObject({ status: "skipped", skipReason: "closed" });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an abort during a poll wait ends the batch as interrupted with no child.
test("an abort during a poll wait exits 130", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const child = childDouble();
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    controller.abort();
    const { exitCode, summary } = await run;
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(child.calls).toHaveLength(0);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: the notifier receives one event for a decision, one for a merge, one for completion.
test("the notifier receives decision, merge, and completion events", async () => {
  const decisionEvents = [];
  const first = await waitPrepared([1]);
  const firstRoot = join(first.workTreeRoot, "runs");
  const firstChild = childDouble();
  try {
    await runBatch({
      prepared: first,
      runsRoot: firstRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          decisionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: firstChild.spawn,
        installSignal: false,
      },
    });
    await updateLoop(firstRoot, first.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the state",
      pid: null,
      startTime: null,
    }));
    await runBatch({
      prepared: { ...first, resume: true },
      runsRoot: firstRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          decisionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(decisionEvents.some((event) => event.kind === "decision")).toBe(true);

    const completionEvents = [];
    const second = await waitPrepared([1]);
    await runBatch({
      prepared: second,
      runsRoot: join(second.workTreeRoot, "runs"),
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          completionEvents.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(completionEvents.some((event) => event.kind === "batch-completed")).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: batch status carries the decision options, the recommendation, and completion.
test("batch status shows decision details and completion", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the state",
      pid: null,
      startTime: null,
    }));
    await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.completion).toEqual({ status: "waiting", complete: false });
    expect(status.loops[0].decision.options).toEqual(["resume", "abandon"]);
    expect(status.loops[0].decision.recommended).toBe("resume");
    expect(status.loops[0].decision.state).toBe("pending");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a waiting issue sends one merge-required notification when the blockers first appear.
test("a waiting issue sends a merge-required notification", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const events = [];
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy")) {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        return {
          status: 0,
          stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
          stderr: "",
        };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const child = childDouble();
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    controller.abort();
    await run;
    const merge = events.filter((event) => event.kind === "merge-required");
    expect(merge).toHaveLength(1);
    expect(merge[0].text).toContain("9");
    expect(child.calls).toHaveLength(0);
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0].requiredMerges).toEqual([9]);
    expect(status.completion).toEqual({ status: "interrupted", complete: false });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a malformed decision file fails closed and never restarts the loop.
test("a malformed decision keeps the loop needs-owner on resume", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await updateLoop(runsRoot, prepared.id, 1, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "a damaged state",
      decision: "bad-decision",
      pid: null,
      startTime: null,
    }));
    await mkdir(batchPaths(runsRoot).decisions(prepared.id), { recursive: true });
    await writeFile(batchPaths(runsRoot).decision(prepared.id, "bad-decision"), "{");
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
    expect(resumed.exitCode).toBe(1);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a pending decision and a merge wait both survive, and only the unblocked loop runs.
test("a pending decision and a merge wait survive a resume", async () => {
  const prepared = await waitPrepared([1, 2], { loops: 2 });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const ghWith = (openIssue1) => (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const issue = Number(args[2]);
      if (args.includes("state,blockedBy")) {
        const open = openIssue1 && issue === 1 ? [{ number: 9, state: "OPEN" }] : [];
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: open } }),
          stderr: "",
        };
      }
      if (args.some((arg) => arg.includes("blockedBy"))) {
        const open = openIssue1 && issue === 1 ? [{ number: 9, state: "OPEN" }] : [];
        return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
      }
      if (args.includes("body"))
        return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
      if (args.includes("title")) {
        return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  try {
    const firstController = new AbortController();
    const first = runBatch({
      prepared,
      runsRoot,
      gh: ghWith(true),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
        signal: firstController.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    firstController.abort();
    await first;
    expect((await readLoop(runsRoot, prepared.id, 1)).status).toBe("waiting");
    expect((await readLoop(runsRoot, prepared.id, 2)).status).toBe("succeeded");
    await updateLoop(runsRoot, prepared.id, 2, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason: "the owner must resolve the state",
      decision: null,
      pid: null,
      startTime: null,
    }));
    let now = 0;
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: ghWith(false),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    expect(child.calls).toHaveLength(1);
    expect(child.calls[0].cwd).toContain("issue-1");
    expect(resumed.summary.loops[0].status).toBe("succeeded");
    expect(resumed.summary.loops[1].status).toBe("needs-owner");
    expect(resumed.summary.loops[1].decision).toBeTruthy();
    expect(resumed.summary.status).toBe("waiting");
  } finally {
    await cleanupRepo();
  }
});

describe("batch decisions and waits", () => {
  let shared;
  beforeAll(async () => {
    const repo = await batchRepo();
    shared = await preparedFor(repo, [1]);
  });

  const prep = (issues, overrides = {}) => ({
    ...shared,
    id: newBatchId(),
    issues,
    loops: overrides.loops ?? issues.length,
    ...overrides,
  });
  const runsFor = (prepared) => join(shared.workTreeRoot, `runs-${prepared.id}`);

  // A freed slot can launch the next issue before the finished loop's state is written, so wait
  // for the status rather than for a later child's call.
  const waitForStatus = async (runsRoot, batchId, issue, status) => {
    let loop = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      loop = await readLoop(runsRoot, batchId, issue);
      if (loop?.status === status) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return loop;
  };

  async function setNeedsOwner(
    runsRoot,
    prepared,
    issue,
    { reason, attempts = 1, decision, pid = null, startTime = null, decisionAnswer = null },
  ) {
    await updateLoop(runsRoot, prepared.id, issue, (loop) => ({
      ...loop,
      status: "needs-owner",
      reason,
      attempts,
      decision: decision ?? null,
      decisionAnswer,
      pid,
      startTime,
      skipReason: null,
    }));
  }

  async function makeDecision(runsRoot, prepared, issue, { reason, attempts = 1 }) {
    const id = newDecisionId(prepared.id, issue, attempts, reason);
    await createDecision({
      runsRoot,
      batchId: prepared.id,
      id,
      issue,
      attempt: attempts,
      reason,
      evidence: reason,
    });
    return id;
  }

  // Usefulness: a live answer keeps its identity and never launches or releases the claim.
  test("a live answer on a resumed loop never launches", async () => {
    const prepared = prep([201]);
    const runsRoot = runsFor(prepared);
    const live = execa(process.execPath, ["-e", "setTimeout(() => {}, 8000)"]);
    live.catch(() => {});
    try {
      await runBatch({
        prepared,
        runsRoot,
        gh: fakeGh({ closed: new Set([201]) }),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: childDouble().spawn,
          installSignal: false,
        },
      });
      const reason = "a live state";
      const decision = await makeDecision(runsRoot, prepared, 201, { reason });
      await setNeedsOwner(runsRoot, prepared, 201, {
        reason,
        decision,
        pid: live.pid,
      });
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: decision,
        option: "abandon",
      });
      expect(answered.ok).toBe(true);
      const child = childDouble();
      const resumed = await runBatch({
        prepared: { ...prepared, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
      });
      expect(child.calls).toHaveLength(0);
      expect(resumed.summary.status).toBe("waiting");
      const loop = await readLoop(runsRoot, prepared.id, 201);
      expect(loop.pid).toBe(live.pid);
      expect(loop.status).toBe("needs-owner");
    } finally {
      live.kill("SIGKILL");
    }
  });

  // Usefulness: an unverified-steps decision lists no resume option that relaunches.
  test("an unverified-steps decision lists no resume option", async () => {
    const prepared = prep([202]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await setNeedsOwner(runsRoot, prepared, 202, {
      reason: "unverified-steps",
      attempts: 1,
    });
    await removePath(batchPaths(runsRoot).transcript(prepared.id, 202));
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    const loop = await readLoop(runsRoot, prepared.id, 202);
    const decision = await readDecision(runsRoot, prepared.id, loop.decision);
    expect(decision.ok).toBe(true);
    expect(decision.decision.options.map((option) => option.key)).toEqual(["abandon", "skip"]);
    expect(decision.decision.recommended).toBe("abandon");
    const refused = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: loop.decision,
      option: "resume",
    });
    expect(refused.ok).toBe(false);
    expect(resumed.summary.status).toBe("waiting");
  });

  // Usefulness: a waiting issue takes a free slot while another child still runs.
  test("a waiting issue launches while another child runs", async () => {
    const prepared = prep([203, 204], { loops: 2 });
    const runsRoot = runsFor(prepared);
    let blockedReads = 0;
    const gh = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        const issue = Number(args[2]);
        if (args.includes("state,blockedBy")) {
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", blockedBy: { nodes: [] } }),
            stderr: "",
          };
        }
        if (args.some((arg) => arg.includes("blockedBy"))) {
          blockedReads += issue === 203 ? 1 : 0;
          const open = issue === 203 && blockedReads === 1 ? [{ number: 9, state: "OPEN" }] : [];
          return { status: 0, stdout: JSON.stringify({ blockedBy: { nodes: open } }), stderr: "" };
        }
        if (args.includes("body"))
          return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
        if (args.includes("title")) {
          return { status: 0, stdout: JSON.stringify({ title: "A title" }), stderr: "" };
        }
        return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    let now = 0;
    const child = childDouble({ hold: true });
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 1000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 50 && child.calls.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(child.calls).toHaveLength(2);
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      await run;
    } finally {
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a held child's gate is resolvable from `pending` as soon as its call is visible,
  // so a case that waits for the call cannot hang on a gate that a delayed transcript write hides.
  test("a held child's gate is reachable before its transcript write", async () => {
    const prepared = prep([220]);
    const runsRoot = runsFor(prepared);
    const write = deferred();
    const child = childDouble({ hold: true, beforeWrite: () => write.promise });
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    try {
      for (let attempt = 0; attempt < 50 && child.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(child.calls).toHaveLength(1);
      expect(child.pending).toHaveLength(1);
      child.pending[0].resolve({ exitCode: 0 });
      write.resolve();
      const { exitCode } = await run;
      expect(exitCode).toBe(0);
    } finally {
      write.resolve();
      for (const call of child.calls) call.gate?.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a new owner stop after an applied answer creates a new decision id.
  test("a new stop after an applied answer creates a new decision", async () => {
    const prepared = prep([205]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "the recorded work tree is missing";
    const first = await makeDecision(runsRoot, prepared, 205, { reason });
    await setNeedsOwner(runsRoot, prepared, 205, { reason, decision: first });
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: first,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    await setNeedsOwner(runsRoot, prepared, 205, {
      reason,
      decision: first,
      decisionAnswer: "resume",
    });
    const transcript = batchPaths(runsRoot).transcript(prepared.id, 205);
    const data = JSON.parse(await readFile(transcript, "utf8"));
    await writeFile(transcript, JSON.stringify({ ...data, exitCode: 130 }));
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "needs-owner",
          reason: "the recorded work tree is missing",
          pr: null,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const loop = await readLoop(runsRoot, prepared.id, 205);
    expect(loop.status).toBe("needs-owner");
    expect(loop.decision).not.toBe(first);
    expect((await readDecision(runsRoot, prepared.id, loop.decision)).ok).toBe(true);
    expect(resumed.summary.status).toBe("waiting");
  });

  // Usefulness: a live answer updates the status and completes the batch once.
  test("a live abandon answer completes the batch", async () => {
    const prepared = prep([206, 207], { loops: 2 });
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([206, 207]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a live decision";
    const decision = await makeDecision(runsRoot, prepared, 206, { reason });
    await setNeedsOwner(runsRoot, prepared, 206, { reason, decision });
    await updateLoop(runsRoot, prepared.id, 207, (loop) => ({
      ...loop,
      status: "queued",
      attempts: 0,
      workTree: null,
      pid: null,
      startTime: null,
    }));
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const events = [];
    const child = childDouble({ hold: true });
    const run = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: child.spawn,
        installSignal: false,
        pollIntervalMs: 50,
      },
    });
    try {
      for (let attempt = 0; attempt < 100 && child.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(child.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: decision,
        option: "abandon",
      });
      expect(answered.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
      const { exitCode, summary } = await run;
      expect(exitCode).toBe(1);
      expect(summary.status).toBe("failed");
      expect(summary.loops[0].status).toBe("failed");
      expect(summary.loops[1].status).toBe("succeeded");
      expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
    } finally {
      for (const pending of child.pending) pending.resolve({ exitCode: 0 });
    }
  });

  // Usefulness: a malformed decision isolates its loop and keeps the queue running.
  test("a malformed decision isolates its loop", async () => {
    const prepared = prep([208, 209], { loops: 2 });
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([208, 209]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    await setNeedsOwner(runsRoot, prepared, 208, {
      reason: "unverified-steps",
      attempts: 1,
    });
    await updateLoop(runsRoot, prepared.id, 209, (loop) => ({
      ...loop,
      status: "queued",
      attempts: 0,
      workTree: null,
      pid: null,
      startTime: null,
    }));
    const broken = newDecisionId(prepared.id, 208, 1, "unverified-steps");
    await mkdir(batchPaths(runsRoot).decisions(prepared.id), { recursive: true });
    await writeFile(batchPaths(runsRoot).decision(prepared.id, broken), "{");
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(1);
    expect(resumed.summary.loops[0].status).toBe("needs-owner");
    expect(resumed.summary.loops[0].reason).toContain("unreadable");
    expect(resumed.summary.loops[1].status).toBe("succeeded");
  });

  // Usefulness: a resume of only an unanswered decision writes nothing.
  test("a resume of only an unanswered decision writes nothing", async () => {
    const prepared = prep([210]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a waiting state";
    const decision = await makeDecision(runsRoot, prepared, 210, { reason });
    await setNeedsOwner(runsRoot, prepared, 210, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({ ...value, status: "waiting" }));
    const manifestFile = batchPaths(runsRoot).manifest(prepared.id);
    const loopFile = batchPaths(runsRoot).loop(prepared.id, 210);
    const beforeManifest = await stat(manifestFile, { bigint: true });
    const beforeLoop = await stat(loopFile, { bigint: true });
    const child = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(child.calls).toHaveLength(0);
    expect(resumed.summary.status).toBe("waiting");
    expect((await stat(manifestFile, { bigint: true })).mtimeNs).toBe(beforeManifest.mtimeNs);
    expect((await stat(loopFile, { bigint: true })).mtimeNs).toBe(beforeLoop.mtimeNs);
  });

  // Usefulness: a poll read carries a timeout and the abort signal.
  test("a poll read carries a timeout and the abort signal", async () => {
    const prepared = prep([211]);
    const runsRoot = runsFor(prepared);
    let pollOptions = null;
    const gh = (args, cwd, options) => {
      if (args[0] === "issue" && args[1] === "view") {
        if (args.includes("state,blockedBy")) {
          pollOptions = options;
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
            }),
            stderr: "",
          };
        }
        if (args.some((arg) => arg.includes("blockedBy"))) {
          return {
            status: 0,
            stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
            stderr: "",
          };
        }
        if (args.includes("body"))
          return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    const child = childDouble();
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 10,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    await run;
    expect(pollOptions).not.toBeNull();
    expect(typeof pollOptions.timeoutMs).toBe("number");
    expect(pollOptions.timeoutMs).toBeGreaterThan(0);
    expect(pollOptions.signal).toBeInstanceOf(AbortSignal);
    expect(child.calls).toHaveLength(0);
  });

  // Usefulness: a caller cancel keeps its own reason object through the poll.
  test("a caller cancel keeps its reason identity", async () => {
    const prepared = prep([212]);
    const runsRoot = runsFor(prepared);
    const gh = (args) => {
      if (args[0] === "issue" && args[1] === "view") {
        if (args.includes("state,blockedBy")) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
            }),
            stderr: "",
          };
        }
        if (args.some((arg) => arg.includes("blockedBy"))) {
          return {
            status: 0,
            stdout: JSON.stringify({ blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }),
            stderr: "",
          };
        }
        if (args.includes("body"))
          return { status: 0, stdout: JSON.stringify({ body: BODY }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { status: 0, stdout: JSON.stringify([]), stderr: "" };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: "o/r" }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Could not resolve to a PullRequest with the number.",
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    const reason = { code: "operator-cancel" };
    let seen = null;
    const controller = new AbortController();
    const child = childDouble();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 60_000,
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                seen = signal.reason;
                resolve();
              },
              { once: true },
            );
          }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort(reason);
    const { exitCode } = await run;
    expect(exitCode).toBe(130);
    expect(seen).toBe(reason);
  });

  // Usefulness: a recorded live child holds its only slot until the process dies.
  test("a recorded live child holds its slot until it dies", async () => {
    const prepared = prep([213, 214], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const live = execa(process.execPath, ["-e", "setTimeout(() => {}, 8000)"]);
    live.catch(() => {});
    try {
      await runBatch({
        prepared,
        runsRoot,
        gh: fakeGh({ closed: new Set([213, 214]) }),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: childDouble().spawn,
          installSignal: false,
        },
      });
      const reason = "a live decision";
      const decision = await makeDecision(runsRoot, prepared, 213, { reason });
      await setNeedsOwner(runsRoot, prepared, 213, { reason, decision, pid: live.pid });
      await updateLoop(runsRoot, prepared.id, 214, (loop) => ({
        ...loop,
        status: "queued",
        attempts: 0,
        workTree: null,
        pid: null,
        startTime: null,
      }));
      const child = childDouble({ hold: true });
      const run = runBatch({
        prepared: { ...prepared, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: child.spawn,
          installSignal: false,
          pollIntervalMs: 50,
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(child.calls).toHaveLength(0);
        live.kill("SIGKILL");
        for (let attempt = 0; attempt < 50 && child.calls.length < 1; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(child.calls).toHaveLength(1);
        for (const pending of child.pending) pending.resolve({ exitCode: 0 });
        await run;
      } finally {
        for (const pending of child.pending) pending.resolve({ exitCode: 0 });
        await run.catch(() => {});
      }
    } finally {
      live.kill("SIGKILL");
    }
  });

  // Usefulness: a resume after an abandon finalizes the batch and sends one completion.
  test("a resume after an abandon finalizes the batch", async () => {
    const prepared = prep([215]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([215]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a stopped state";
    const decision = await makeDecision(runsRoot, prepared, 215, { reason });
    await setNeedsOwner(runsRoot, prepared, 215, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: decision,
      option: "abandon",
    });
    expect(answered.ok).toBe(true);
    const events = [];
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(1);
    expect(resumed.summary.status).toBe("failed");
    expect(resumed.summary.loops[0].status).toBe("failed");
    expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
  });

  // Usefulness: a resume after a skip finalizes the batch as complete with one notification.
  test("a resume after a skip finalizes the batch", async () => {
    const prepared = prep([216]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([216]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const id = newDecisionId(prepared.id, 216, 1, "unverified-steps");
    await createDecision({
      runsRoot,
      batchId: prepared.id,
      id,
      issue: 216,
      attempt: 1,
      reason: "unverified-steps",
      evidence: "the transcript is missing",
      options: UNVERIFIED_STEPS_OPTIONS,
      recommended: "abandon",
    });
    await setNeedsOwner(runsRoot, prepared, 216, {
      reason: "unverified-steps",
      decision: id,
    });
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "waiting",
      completionNotified: false,
    }));
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: id,
      option: "skip",
    });
    expect(answered.ok).toBe(true);
    const events = [];
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          events.push(event);
          return { spawned: false, ok: true };
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.summary.status).toBe("completed");
    expect(resumed.summary.loops[0].status).toBe("skipped");
    expect(events.filter((event) => event.kind === "batch-completed")).toHaveLength(1);
  });

  // Usefulness: a held lock with an unanswered decision reports paused, not waiting.
  test("a held lock with an unanswered decision reports paused", async () => {
    const prepared = prep([217]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({ closed: new Set([217]) }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    const reason = "a waiting state";
    const decision = await makeDecision(runsRoot, prepared, 217, { reason });
    await setNeedsOwner(runsRoot, prepared, 217, { reason, decision });
    await updateManifest(runsRoot, prepared.id, (value) => ({ ...value, status: "waiting" }));
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-217.resume.lock");
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    try {
      const resumed = await runBatch({
        prepared: { ...prepared, resume: true },
        runsRoot,
        gh: fakeGh(),
        deps: {
          ...fakeGitDeps,
          notifier: noNotify,
          spawn: childDouble().spawn,
          installSignal: false,
        },
      });
      expect(resumed.exitCode).toBe(1);
      expect(resumed.summary.status).toBe("paused");
      expect(resumed.summary.loops[0].status).toBe("needs-owner");
    } finally {
      await release?.();
    }
  });

  // Usefulness: a resumed exit 4 loop reconciles the pull request head and can end succeeded.
  test("an answered resume on an exit 4 loop reconciles the pull request", async () => {
    const prepared = prep([218]);
    const runsRoot = runsFor(prepared);
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 4, pr: 42 }).spawn,
        installSignal: false,
      },
    });
    const stopped = await readLoop(runsRoot, prepared.id, 218);
    expect(stopped).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: stopped.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "succeeded",
          reason: null,
          pr: 42,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.summary.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
  });

  // Usefulness: a live resume answer continues the same transcript and recorded pull request.
  test("a live resume answer continues the same transcript and pull request", async () => {
    const prepared = prep([219, 220], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble();
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 219, "needs-owner");
      expect(stopped.calls).toHaveLength(1);
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (let attempt = 0; attempt < 200 && continued.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(continued.calls).toHaveLength(1);
      const args = continued.calls[0].args;
      const continueIndex = args.indexOf("--continue-from");
      expect(continueIndex).toBeGreaterThan(-1);
      expect(args[continueIndex + 1]).toBe(stopped.calls[0].transcript);
      expect(args[args.indexOf("--pr") + 1]).toBe("42");
      await continued.calls[0].written;
      const data = JSON.parse(await readFile(stopped.calls[0].transcript, "utf8"));
      expect(data.events.some((event) => event.type === "continued")).toBe(true);
      expect(data.events.some((event) => event.type === "pr-declared")).toBe(true);
      await run;
    } finally {
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer refreshes eligibility and does not launch past an open blocker.
  test("a live resume answer does not launch past an open blocker", async () => {
    const prepared = prep([222, 223], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let blocked = false;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (blocked && args[0] === "issue" && args[1] === "view" && args[2] === "222") {
        if (args.some((arg) => typeof arg === "string" && arg.includes("blockedBy"))) {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              blockedBy: { nodes: [{ number: 9, state: "OPEN" }] },
            }),
            stderr: "",
          };
        }
      }
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 222, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      blocked = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await readLoop(runsRoot, prepared.id, 222);
        if (continued.calls.length > 0 || current.status === "waiting") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(continued.calls).toHaveLength(0);
      expect((await readLoop(runsRoot, prepared.id, 222)).status).toBe("waiting");
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a held resume lock stops a live resume answer before it launches.
  test("a held resume lock stops a live resume answer", async () => {
    const prepared = prep([224, 225], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const controller = new AbortController();
    const lockFile = join(runsRoot, "batches", prepared.id, "loops", "issue-224.resume.lock");
    const release = await tryStateLock(lockFile, { label: "Batch loop", noun: "batch loop" });
    expect(release).not.toBe(null);
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 224, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      const raced = await Promise.race([
        run.then((value) => ({ value })),
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);
      expect(continued.calls).toHaveLength(0);
      expect(raced).not.toBe(null);
      expect(raced.value.summary.status).toBe("paused");
      expect((await readLoop(runsRoot, prepared.id, 224)).status).toBe("queued");
    } finally {
      await release?.();
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer ignores its own open pull request closure and continues.
  test("a live resume answer ignores its own open pull request closure", async () => {
    const prepared = prep([226, 227], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble();
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let closing = false;
    const ownBranch = `batch/${prepared.id}/226`;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (
        closing &&
        args[0] === "pr" &&
        args[1] === "list" &&
        args.includes("--state") &&
        !args.includes("--head")
      ) {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 42, headRefName: ownBranch, closingIssuesReferences: [{ number: 226 }] },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 226, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      closing = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (let attempt = 0; attempt < 100 && continued.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(continued.calls).toHaveLength(1);
      const args = continued.calls[0].args;
      const continueIndex = args.indexOf("--continue-from");
      expect(continueIndex).toBeGreaterThan(-1);
      expect(args[continueIndex + 1]).toBe(stopped.calls[0].transcript);
      expect(args[args.indexOf("--pr") + 1]).toBe("42");
      await run;
      expect((await readLoop(runsRoot, prepared.id, 226)).status).toBe("succeeded");
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a live resume answer does not launch a loop that used every step.
  test("a live resume answer does not launch an exhausted loop", async () => {
    const prepared = prep([228, 229], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, steps: 10, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 228, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await readLoop(runsRoot, prepared.id, 228);
        if (continued.calls.length > 0 || current.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(continued.calls).toHaveLength(0);
      await run;
      expect(await readLoop(runsRoot, prepared.id, 228)).toMatchObject({
        status: "failed",
        reason: "step-budget-exhausted",
      });
      const claim = batchPaths(runsRoot).claim(prepared.repoKey, 228);
      await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: an open pull request of another branch still skips the loop.
  test("an open pull request of another branch still skips the loop", async () => {
    const prepared = prep([230, 231], { loops: 1 });
    const runsRoot = runsFor(prepared);
    const stopped = childDouble({ exitCode: 4, pr: 42 });
    const holding = childDouble({ hold: true });
    const continued = childDouble({ hold: true });
    const children = [stopped, holding, continued];
    let spawnIndex = 0;
    const spawn = (options) => children[Math.min(spawnIndex++, children.length - 1)].spawn(options);
    let closing = false;
    const baseGh = fakeGh();
    const gh = (args) => {
      if (
        closing &&
        args[0] === "pr" &&
        args[1] === "list" &&
        args.includes("--state") &&
        !args.includes("--head")
      ) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 99,
              headRefName: "another-branch",
              closingIssuesReferences: [{ number: 230 }],
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
      return baseGh(args);
    };
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
        pollIntervalMs: 20,
      },
    });
    try {
      const loop = await waitForStatus(runsRoot, prepared.id, 230, "needs-owner");
      expect(loop).toMatchObject({ status: "needs-owner", reason: "pr-head-unresolved" });
      for (let attempt = 0; attempt < 100 && holding.calls.length < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(holding.calls).toHaveLength(1);
      closing = true;
      const answered = await answerDecision({
        runsRoot,
        batchId: prepared.id,
        decisionId: loop.decision,
        option: "resume",
      });
      expect(answered.ok).toBe(true);
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (let attempt = 0; attempt < 100 && continued.calls.length < 1; attempt += 1) {
        const current = await readLoop(runsRoot, prepared.id, 230);
        if (current.status === "skipped") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(continued.calls).toHaveLength(0);
      expect(await readLoop(runsRoot, prepared.id, 230)).toMatchObject({
        status: "skipped",
        skipReason: "closed-by-open-pr",
      });
      await run;
    } finally {
      controller.abort();
      for (const pending of holding.pending) pending.resolve({ exitCode: 0 });
      for (const pending of continued.pending) pending.resolve({ exitCode: 0 });
      await run.catch(() => {});
    }
  });

  // Usefulness: a batch resume answer continues the same transcript and recorded pull request.
  test("a batch resume answer continues the same transcript and pull request", async () => {
    const prepared = prep([221]);
    const runsRoot = runsFor(prepared);
    const first = childDouble({ exitCode: 4, pr: 42 });
    await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
      },
    });
    const stopped = await readLoop(runsRoot, prepared.id, 221);
    const answered = await answerDecision({
      runsRoot,
      batchId: prepared.id,
      decisionId: stopped.decision,
      option: "resume",
    });
    expect(answered.ok).toBe(true);
    const continued = childDouble();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        reconcileLoop: async () => ({
          status: "resume",
          reason: null,
          pr: 42,
          requireCi: null,
        }),
        notifier: noNotify,
        spawn: continued.spawn,
        installSignal: false,
      },
    });
    expect(continued.calls).toHaveLength(1);
    const args = continued.calls[0].args;
    const continueIndex = args.indexOf("--continue-from");
    expect(continueIndex).toBeGreaterThan(-1);
    expect(args[continueIndex + 1]).toBe(first.calls[0].transcript);
    expect(args[args.indexOf("--pr") + 1]).toBe("42");
    expect(resumed.exitCode).toBe(0);
  });
});

// A prepared batch for the report cases: no Git process starts.
async function preparedReportLoop() {
  const root = await mkdtemp(join(tmpdir(), "batch-report-root-"));
  roots.push(root);
  return {
    id: newBatchId(),
    repo: "/repo",
    repoKey: "report-key",
    base: "main",
    workTreeRoot: root,
    issues: [1],
    loops: 1,
    maxSteps: 10,
    setupCmd: null,
    setupTimeout: 600,
    taskTemplate: "Work {issue}",
    testCmd: null,
    testCmdTimeout: null,
    timeout: 3600,
    reviewerSandbox: null,
    roles: {
      orchestrator: { kind: "codex", model: null, effort: null },
      worker: { kind: "claude", model: null, effort: null },
      reviewer: { kind: "agy", model: null, effort: null },
    },
  };
}

// Usefulness: start, status, and an idle resume show the same stored loop report without a transcript read.
test("start, status, and resume show the same stored loop report", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const summary = {
    changed: "the change",
    verified: "the checks",
    deferred: "nothing",
    notDone: "nothing",
    open: "none",
    notes: "a later check",
  };
  const child = childDouble({ summary });
  const deps = {
    ...fakeGitDeps,
    notifier: noNotify,
    spawn: child.spawn,
    installSignal: false,
  };
  const started = await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh(),
    deps,
  });
  expect(started.summary.loops[0].report.state).toBe("read");
  expect(started.summary.loops[0].report.summary).toEqual(summary);
  await removePath(child.calls[0].transcript);
  const status = await readBatchStatus({ runsRoot, id: prepared.id });
  expect(status.loops[0].report).toEqual(started.summary.loops[0].report);
  const resumed = await runBatch({
    prepared: { ...prepared, resume: true },
    runsRoot,
    gh: fakeGh(),
    deps: { ...deps, spawn: childDouble().spawn },
  });
  expect(resumed.summary.loops[0].report).toEqual(started.summary.loops[0].report);
});

// Usefulness: a failed loop report names the error, the fatal turn test, and the run warnings.
test("a failed loop report carries the error, failed turn test, and warnings", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const failedTurnTest = { command: "pnpm test", status: "fail", exitCode: 1 };
  const warning = "turn temporary directory not removed, delete it by hand: /tmp/al-x";
  const child = childDouble({
    exitCode: 1,
    error: "the child failed",
    failedTurnTest,
    warnings: [warning],
  });
  const { exitCode, summary } = await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh(),
    deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
  });
  expect(exitCode).toBe(1);
  const report = summary.loops[0].report;
  expect(report.state).toBe("read");
  expect(report.summary).toBeNull();
  expect(report.error).toBe("the child failed");
  expect(report.failedTurnTest).toEqual(failedTurnTest);
  expect(report.warnings).toContain(warning);
});

// Usefulness: recovery writes the report in the status checkpoint from the transcript it reads.
test("a recovered transcript reports its finish summary", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ hold: true });
  const controller = new AbortController();
  const summary = {
    changed: "recovered",
    verified: "the checks",
    deferred: "nothing",
    notDone: "nothing",
    open: "none",
    notes: null,
  };
  const run = runBatch({
    prepared,
    runsRoot,
    gh: fakeGh(),
    deps: {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: child.spawn,
      installSignal: false,
      signal: controller.signal,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  controller.abort();
  await run;
  const transcript = child.calls[0].transcript;
  const data = JSON.parse(await readFile(transcript, "utf8"));
  await writeFile(
    transcript,
    JSON.stringify({
      ...data,
      events: [{ type: "action", action: { action: "finish", summary } }, { type: "gate" }],
      exitCode: 0,
      error: null,
    }),
  );
  const resumed = await runBatch({
    prepared: { ...prepared, resume: true },
    runsRoot,
    gh: fakeGh(),
    deps: { ...fakeGitDeps, notifier: noNotify, spawn: childDouble().spawn, installSignal: false },
  });
  expect(resumed.summary.loops[0].status).toBe("succeeded");
  expect(resumed.summary.loops[0].report.state).toBe("read");
  expect(resumed.summary.loops[0].report.summary).toEqual(summary);
});

// Usefulness: a stored loop without a report reads as missing, not as no error and no warnings.
test("a stored loop without a report reads as missing", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({
    exitCode: 1,
    error: "the child failed",
  });
  await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh(),
    deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
  });
  await updateLoop(runsRoot, prepared.id, 1, (loop) => {
    const next = { ...loop };
    delete next.report;
    return next;
  });
  const status = await readBatchStatus({ runsRoot, id: prepared.id });
  const report = status.loops[0].report;
  expect(report.state).toBe("missing");
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.error).toBeNull();
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
});

// Usefulness: a loop end with no transcript reports the unread state, not a clean loop.
test("a loop end without a transcript reports the unread state", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const spawn = async () => {
    throw new Error("the spawn failed");
  };
  const { summary } = await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh(),
    deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
  });
  const report = summary.loops[0].report;
  expect(summary.loops[0].status).toBe("failed");
  expect(report.state).toBe("unread");
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.error).toBeNull();
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
});

// Usefulness: a skipped loop with no attempt reports the explicit no-attempt state.
test("a skipped loop with no attempt reports the no-attempt state", async () => {
  const prepared = await preparedReportLoop();
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const { summary } = await runBatch({
    prepared,
    runsRoot,
    gh: fakeGh({ closed: new Set([1]) }),
    deps: { ...fakeGitDeps, notifier: noNotify, spawn: childDouble().spawn, installSignal: false },
  });
  const report = summary.loops[0].report;
  expect(summary.loops[0].status).toBe("skipped");
  expect(report.state).toBe("no-attempt");
  expect(report.warnings).toEqual([]);
  expect(report.warningsOverflow).toBe(0);
});
