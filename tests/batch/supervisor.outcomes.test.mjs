import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { readDecision } from "../../src/batch/decisions.mjs";
import { readBatchStatus } from "../../src/batch/status.mjs";
import { batchPaths, readLoop, updateLoop } from "../../src/batch/store.mjs";
import { runBatch } from "../../src/batch/supervisor.mjs";
import {
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

// Usefulness: a child that exits 1 stays failed on the normal path and reports the failure once.
test("a child that exits 1 is failed on the normal path", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const lines = [];
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((line) => lines.push(String(line)));
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
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
    const failures = lines.filter((line) => line.includes("failed (exit 1)"));
    expect(failures).toHaveLength(1);
    expect(failures[0].startsWith("[agent-loop] error: ")).toBe(true);
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    errorSpy.mockRestore();
    writeSpy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: an abort transcript stops failed with reason aborted, names it once, and frees the claim.
test("a child that exits 1 after an abort is aborted on the normal path", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const lines = [];
  const errorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((line) => lines.push(String(line)));
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({
          exitCode: 1,
          abort: "The issue is already done on the base branch.\nA later line stays out.",
          error: "The issue is already done on the base branch.",
        }).spawn,
        installSignal: false,
      },
    });
    expect(exitCode).toBe(1);
    expect(summary.loops[0]).toMatchObject({ status: "failed", reason: "aborted" });
    const failures = lines.filter((line) => line.includes("failed (aborted"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("already done on the base branch");
    expect(failures[0]).not.toContain("A later line stays out");
    const claim = batchPaths(runsRoot).claim(prepared.repoKey, 1);
    await expect(stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
    const loop = await readLoop(runsRoot, prepared.id, 1);
    expect(loop.reason).toBe("aborted");
  } finally {
    errorSpy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: an exit 0 loop reports the runtime pull request in the summary and in batch status.
test("an exit 0 loop records the pull request its runtime declared", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ pr: 42 }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a failed loop reports the runtime pull request in the summary and in batch status.
test("a failed loop records the pull request its runtime declared", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 1, pr: 42 }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({ status: "failed", reason: "exit-1", pr: 42 });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "failed", reason: "exit-1", pr: 42 });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an exit 0 loop with no declaration keeps pr null in the summary and in batch status.
test("an exit 0 loop without a declaration records no pull request", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { summary } = await runBatch({
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
    expect(summary.loops[0]).toMatchObject({ status: "succeeded", pr: null });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "succeeded", pr: null });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a malformed declared pull request stops a failed loop needs-owner, not failed.
test("a failed loop with an unreadable declaration stops needs-owner", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ exitCode: 1, pr: "unreadable" }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({ status: "needs-owner", pr: null });
    expect(summary.loops[0].reason).toContain("unreadable pull request");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a cancel exit records the runtime pull request in the summary and in batch status.
test("an interrupted loop records the pull request its runtime declared", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const child = childDouble({ pr: 42, hold: true });
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
    const { summary } = await run;
    expect(summary.loops[0]).toMatchObject({ status: "interrupted", pr: 42 });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "interrupted", pr: 42 });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a two-link continuation chain ends once and reports its single declared pull request.
test("a two-link continuation chain reports the declared pull request once", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ steps: 1, hold: true });
  const second = childDouble({ steps: 1, hold: true });
  const third = childDouble({ steps: 1, pr: 42 });
  try {
    const firstController = new AbortController();
    const firstRun = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
        signal: firstController.signal,
      },
    });
    await waitForLaunch(first);
    firstController.abort();
    await firstRun;

    const secondController = new AbortController();
    const secondRun = runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: second.spawn,
        installSignal: false,
        signal: secondController.signal,
      },
    });
    await waitForLaunch(second);
    expect(second.calls[0].args).toContain("--continue-from");
    secondController.abort();
    await secondRun;

    const final = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: third.spawn,
        installSignal: false,
      },
    });
    expect(third.calls).toHaveLength(1);
    expect(third.calls[0].args).toContain("--continue-from");
    const data = JSON.parse(await readFile(third.calls[0].transcript, "utf8"));
    expect(data.events.filter((event) => event.type === "continued")).toHaveLength(2);
    expect(data.events.filter((event) => event.type === "pr-declared")).toHaveLength(1);
    expect(final.summary.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({ status: "succeeded", pr: 42 });
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
