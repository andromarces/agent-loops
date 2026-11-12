import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { createLoopWorkTree, git } from "../../src/batch/git.mjs";
import { batchPaths, readLoop, readManifest, updateLoop } from "../../src/batch/store.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import { childArguments } from "../../src/batch/worker.mjs";
import {
  BODY,
  batchRepo,
  childDouble,
  cleanupRepo,
  fakeGh,
  fakeGitDeps,
  noNotify,
  preparedFor,
  waitForLaunch,
  waitPrepared,
} from "./supervisor-helpers.mjs";

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
      deps: {
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        // An unpushed commit keeps the work tree after real cleanup, so its branch stays readable.
        createWorkTree: async (options) => {
          const tree = await createLoopWorkTree(options);
          await git(["commit", "--allow-empty", "-m", "work on the issue"], tree.path);
          return tree;
        },
      },
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    await waitForLaunch(child, 1);
    expect(child.calls.length).toBe(2);
    child.pending[0].resolve({ exitCode: 0 });
    await waitForLaunch(child, 2);
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    await waitForLaunch(child);
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
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
    await waitForLaunch(child);
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
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
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: child.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(child);
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
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: resumeChild.spawn, installSignal: false },
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

// Usefulness: one issue launch reads the title with its eligibility call, so it starts one fewer gh.
test("one issue launch reads the title with its eligibility call", async () => {
  const prepared = await waitPrepared([1]);
  const calls = [];
  const base = fakeGh();
  const gh = (args, cwd, options) => {
    calls.push(args);
    if (
      args[0] === "issue" &&
      args[1] === "view" &&
      args.some((arg) => arg.startsWith("state,blockedBy,body"))
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          blockedBy: { nodes: [] },
          body: BODY,
          title: "A title",
        }),
        stderr: "",
      };
    }
    return base(args, cwd, options);
  };
  const child = childDouble();
  try {
    const { exitCode } = await runBatch({
      prepared,
      runsRoot: join(prepared.workTreeRoot, "runs"),
      gh,
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    const issueViewCalls = calls.filter((args) => args[0] === "issue" && args[1] === "view");
    expect(issueViewCalls).toHaveLength(1);
    expect(issueViewCalls[0]).toContain("state,blockedBy,body,title");
    const task = child.calls[0].args[child.calls[0].args.indexOf("--task") + 1];
    expect(task).toContain("Work 1 A title on ");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a missing or blank eligibility title falls back to the issue number in the task.
test("a missing or blank issue title falls back to the issue number", async () => {
  try {
    for (const title of [undefined, "   "]) {
      const prepared = await waitPrepared([1]);
      const base = fakeGh();
      const gh = (args, cwd, options) => {
        if (
          args[0] === "issue" &&
          args[1] === "view" &&
          args.some((arg) => arg.startsWith("state,blockedBy,body"))
        ) {
          const view = { state: "OPEN", blockedBy: { nodes: [] }, body: BODY };
          if (title !== undefined) view.title = title;
          return { status: 0, stdout: JSON.stringify(view), stderr: "" };
        }
        return base(args, cwd, options);
      };
      const child = childDouble();
      const { exitCode } = await runBatch({
        prepared,
        runsRoot: join(prepared.workTreeRoot, "runs"),
        gh,
        deps: { ...fakeGitDeps, notifier: noNotify, spawn: child.spawn, installSignal: false },
      });
      expect(exitCode).toBe(0);
      const task = child.calls[0].args[child.calls[0].args.indexOf("--task") + 1];
      expect(task).toContain("Work 1 issue 1 on ");
    }
  } finally {
    await cleanupRepo();
  }
});
