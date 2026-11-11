import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll } from "vite-plus/test";
import { prepareBatch } from "../../src/batch/args.mjs";
import { git } from "../../src/batch/git.mjs";
import { readLoop } from "../../src/batch/store.mjs";
import { newBatchId } from "../../src/batch/supervisor.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";
import { pollUntil, within } from "../wait-helpers.mjs";

export const BODY = ["## Problem", "Missing.", "", "## Acceptance", "", "- one check", ""].join(
  "\n",
);
export const SUMMARY = {
  changed: "a",
  verified: "b",
  deferred: "c",
  notDone: "d",
  open: "e",
  notes: "a note",
};

export function fakeGh({ blocked = [], closed = new Set(), pulls = [] } = {}) {
  return async (args) => {
    if (args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return {
        status: 1,
        stdout: "",
        stderr: "Could not resolve to a PullRequest with the number.",
      };
    }
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("state,blockedBy,body")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: closed.has(Number(args[2])) ? "CLOSED" : "OPEN",
            blockedBy: { nodes: blocked },
            body: BODY,
          }),
          stderr: "",
        };
      }
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

export function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

// A test never shows a desktop notification. A case that reads notifications passes its own.
export const noNotify = async () => ({ spawned: false, ok: true });

// The new wait and decision cases model the work tree and the gates in process.
// No case starts a Git process after the one shared preparation.
export const fakeGitDeps = {
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
export function childDouble({
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

// Waits 10 s for call `index` of `child` and its transcript write on one deadline. A timeout
// names the launch.
export async function waitForLaunch(child, index = 0) {
  const deadline = performance.now() + 10_000;
  const timeout = () => new Error(`child launch ${index} was not ready within 10000 ms.`);
  let call;
  try {
    call = await pollUntil(() => child.calls[index], deadline - performance.now());
  } catch {
    throw timeout();
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw timeout();
  try {
    await within(call.written, remaining, `launch ${index}`);
  } catch {
    throw timeout();
  }
  return call;
}

// A freed slot can launch the next issue before the finished loop's state is written. Wait for
// the status, not a later child's call.
export async function waitForStatus(runsRoot, batchId, issue, status) {
  return pollUntil(async () => {
    const loop = await readLoop(runsRoot, batchId, issue);
    return loop?.status === status ? loop : undefined;
  }, 10_000);
}

// One immutable repository and bare remote for the file. Each case gets its own work-tree root
// and batch id. No case runs git init or an initial push, so mutable state is per test.
export const roots = [];
let sharedRepo;
export async function batchRepo() {
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

export async function preparedFor({ main, base }, issues, overrides = {}) {
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

export async function pushLoop(prepared, issue = 1) {
  const workTree = join(prepared.workTreeRoot, `issue-${issue}`);
  const branch = `batch/${prepared.id}/${issue}`;
  await execa("git", ["push", "-u", "origin", branch], { cwd: workTree });
}

// The shared repository and remote are removed once for the file. Each case removes only the
// work-tree root it created, at `afterAll`, so no case depends on another case's teardown.
export async function cleanupRepo() {}

// One prepared repository serves the new wait cases. Each case gets its own work-tree root.
let sharedWait;
export async function waitPrepared(issues, overrides = {}) {
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
