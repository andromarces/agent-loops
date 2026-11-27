import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { readDecision } from "../../src/batch/decisions.mjs";
import { loopEntry } from "../../src/batch/loop-records.mjs";
import { readBatchStatus } from "../../src/batch/status.mjs";
import {
  batchPaths,
  readLoop,
  readManifest,
  updateLoop,
  updateManifest,
} from "../../src/batch/store.mjs";
import { newBatchId, runBatch } from "../../src/batch/supervisor.mjs";
import {
  batchRepo,
  childDouble,
  cleanupRepo,
  deferred,
  fakeGh,
  fakeGitDeps,
  noNotify,
  preparedFor,
  roots,
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

// Usefulness: after a batch ends, the summary and batch status name both pull requests of two
// succeeded loops and a file beyond the truncated first page that they both change.
test("a batch reports a common file beyond the first 100 files", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const left = Array.from({ length: 205 }, (_, index) =>
    index === 150 ? "src/handler.mjs" : `left/f${index}.mjs`,
  );
  const right = Array.from({ length: 205 }, (_, index) =>
    index === 150 ? "src/handler.mjs" : `right/f${index}.mjs`,
  );
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({
        files: new Map([
          [11, left],
          [12, right],
        ]),
      }),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    expect(summary.overlapGroups).toEqual([{ pulls: [11, 12], paths: ["src/handler.mjs"] }]);
    expect(summary.overlapIncomplete).toEqual([]);
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.overlapGroups).toEqual([{ pulls: [11, 12], paths: ["src/handler.mjs"] }]);
    expect(status.overlapIncomplete).toEqual([]);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a batch whose pull requests share no file reports no group in the summary or in
// batch status, so an absent overlap never reads as one.
test("a batch with no common file reports no group", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({
        files: new Map([
          [11, ["README.md"]],
          [12, ["src/handler.mjs"]],
        ]),
      }),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    expect(summary.overlapGroups).toEqual([]);
    expect(summary.overlapIncomplete).toEqual([]);
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.overlapGroups).toEqual([]);
    expect(status.overlapIncomplete).toEqual([]);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a failed file-list read logs a warning, names the pull request incomplete, and
// leaves the batch completed, so an unreadable pull request never fails the work of other loops.
test("a failed file-list read logs a warning and does not fail the batch", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({
        files: new Map([
          [11, ["src/handler.mjs"]],
          [12, ["src/handler.mjs"]],
        ]),
        unreadableFiles: new Set([12]),
        closingReferences: new Map([
          [11, [1]],
          [12, [2]],
        ]),
      }),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    expect(exitCode).toBe(0);
    expect(summary.status).toBe("completed");
    expect(summary.overlapGroups).toEqual([]);
    expect(summary.overlapIncomplete).toEqual([12]);
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("warn") && line.includes("12"))).toBe(true);
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.completion).toEqual({ status: "completed", complete: true });
    expect(status.overlapIncomplete).toEqual([12]);
  } finally {
    errorSpy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: a file list shorter than the changed-file count is reported incomplete, so a
// truncated list never reads as no overlap.
test("a file list shorter than the changed-file count is reported incomplete", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh({
        files: new Map([
          [11, ["src/handler.mjs"]],
          [12, ["src/handler.mjs"]],
        ]),
        mismatchedFiles: new Set([12]),
      }),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    expect(summary.overlapGroups).toEqual([]);
    expect(summary.overlapIncomplete).toEqual([12]);
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("warn") && line.includes("incomplete"))).toBe(true);
  } finally {
    errorSpy.mockRestore();
    await cleanupRepo();
  }
});

// Usefulness: a stop during the overlap read keeps the interrupted batch and exit 130, and the
// resume then reports the overlap, so a stop never records a completed batch without its report.
test("a stop during the overlap read keeps the interrupt result and the resume reports it", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const files = new Map([
    [11, ["src/handler.mjs"]],
    [12, ["src/handler.mjs"]],
  ]);
  const inner = fakeGh({ files });
  const reached = deferred();
  const gate = deferred();
  const blockedGh = async (args, cwd) => {
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/pulls/11/files")) {
      reached.resolve();
      await gate.promise;
    }
    return inner(args, cwd);
  };
  const controller = new AbortController();
  const notifications = [];
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: blockedGh,
      deps: {
        ...fakeGitDeps,
        notifier: async (event) => {
          notifications.push(event.kind);
        },
        spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await reached.promise;
    controller.abort();
    gate.resolve();
    const { exitCode, summary } = await run;
    expect(exitCode).toBe(130);
    expect(summary.status).toBe("interrupted");
    expect(notifications).not.toContain("batch-completed");
    const manifest = await readManifest(runsRoot, prepared.id);
    expect(manifest.status).toBe("interrupted");
    expect(manifest.overlapGroups).toBeUndefined();
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh({ files }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.summary.status).toBe("completed");
    expect(resumed.summary.overlapGroups).toEqual([
      { pulls: [11, 12], paths: ["src/handler.mjs"] },
    ]);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a cancel of the original command after another resume completed the batch leaves the
// completed manifest and its stored failed-read report in place, and still exits 130.
test("a cancel never moves a batch another process completed", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const files = new Map([
    [11, ["src/handler.mjs"]],
    [12, ["src/handler.mjs"]],
  ]);
  const inner = fakeGh({ files });
  const reached = deferred();
  const gate = deferred();
  const blockedGh = async (args, cwd) => {
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/pulls/11/files")) {
      reached.resolve();
      await gate.promise;
    }
    return inner(args, cwd);
  };
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: blockedGh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await reached.promise;
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      status: "completed",
      overlapGroups: [],
      overlapIncomplete: [11, 12],
    }));
    controller.abort();
    gate.resolve();
    const { exitCode, summary } = await run;
    expect(exitCode).toBe(130);
    const manifest = await readManifest(runsRoot, prepared.id);
    expect(manifest.status).toBe("completed");
    expect(manifest.overlapGroups).toEqual([]);
    expect(manifest.overlapIncomplete).toEqual([11, 12]);
    expect(summary.status).toBe("completed");
    expect(summary.overlapGroups).toEqual([]);
    expect(summary.overlapIncomplete).toEqual([11, 12]);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a resume keeps a stored failed-read report, so a later successful read never replaces
// a report that another process already saved.
test("a resume keeps a stored failed-read report", async () => {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ pr: 11 });
  const second = childDouble({ pr: 12 });
  const spawn = (options) =>
    first.calls.length === 0 ? first.spawn(options) : second.spawn(options);
  const files = new Map([
    [11, ["src/handler.mjs"]],
    [12, ["src/handler.mjs"]],
  ]);
  const inner = fakeGh({ files });
  const reached = deferred();
  const gate = deferred();
  const blockedGh = async (args, cwd) => {
    if (args[0] === "api" && typeof args[1] === "string" && args[1].includes("/pulls/11/files")) {
      reached.resolve();
      await gate.promise;
    }
    return inner(args, cwd);
  };
  const controller = new AbortController();
  try {
    const run = runBatch({
      prepared,
      runsRoot,
      gh: blockedGh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await reached.promise;
    controller.abort();
    gate.resolve();
    await run;
    await updateManifest(runsRoot, prepared.id, (value) => ({
      ...value,
      overlapGroups: [],
      overlapIncomplete: [11, 12],
    }));
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh({ files }),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(resumed.summary.status).toBe("completed");
    expect(resumed.summary.overlapGroups).toEqual([]);
    expect(resumed.summary.overlapIncomplete).toEqual([11, 12]);
    const manifest = await readManifest(runsRoot, prepared.id);
    expect(manifest.overlapGroups).toEqual([]);
    expect(manifest.overlapIncomplete).toEqual([11, 12]);
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

// Usefulness: an exit 0 loop reports the runtime's undeclared pull request beside its finish report.
test("an exit 0 loop records the pull request its runtime left undeclared", async () => {
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
        spawn: childDouble({
          undeclared: 42,
          summary: {
            changed: "a",
            verified: "b",
            deferred: "c",
            notDone: "d",
            open: "CI is pending at finish",
          },
        }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({
      status: "succeeded",
      pr: null,
      prUndeclared: 42,
    });
    expect(summary.loops[0].report.summary.open).toBe("CI is pending at finish");
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({
      status: "succeeded",
      pr: null,
      prUndeclared: 42,
    });
    expect(status.loops[0].report.summary.open).toBe("CI is pending at finish");
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a declared pull request wins over one that an earlier turn left undeclared.
test("a declared pull request wins over an undeclared one", async () => {
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
        spawn: childDouble({ undeclared: 41, pr: 42 }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({ status: "succeeded", pr: 42, prUndeclared: null });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a malformed undeclared record fails closed and records no pull request.
test("a malformed undeclared pull request records no number", async () => {
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
        spawn: childDouble({ undeclared: "42" }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({ status: "succeeded", pr: null, prUndeclared: null });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a continued transcript reads only the undeclared pull request of its last attempt.
test("a continued transcript records its last attempt's undeclared pull request", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ steps: 1, undeclared: 41, hold: true });
  const second = childDouble({ steps: 1, undeclared: 42 });
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

    const final = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: second.spawn,
        installSignal: false,
      },
    });
    expect(final.summary.loops[0]).toMatchObject({
      status: "succeeded",
      pr: null,
      prUndeclared: 42,
    });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a review-only loop records no undeclared pull request, so its finish report stands alone.
test("a review-only loop records no undeclared pull request", async () => {
  const repo = await batchRepo();
  const prepared = await preparedFor(repo, [1], {
    items: [{ kind: "issue", number: 1, key: 1, mode: "review-only", task: null }],
  });
  const runsRoot = join(prepared.workTreeRoot, "runs");
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: childDouble({ undeclared: 42 }).spawn,
        installSignal: false,
      },
    });
    expect(summary.loops[0]).toMatchObject({
      status: "succeeded",
      pr: null,
      prUndeclared: null,
    });
  } finally {
    await cleanupRepo(repo);
  }
});

// Usefulness: a pull request item keeps its frozen number and gains no undeclared number.
test("a pull request item loop entry keeps its frozen number", () => {
  const entry = loopEntry({
    issue: "pr-5",
    kind: "pr",
    mode: "review-first",
    number: 5,
    status: "succeeded",
    pr: 5,
    prUndeclared: null,
  });
  expect(entry).toMatchObject({ pr: 5, prUndeclared: null });
});

// Usefulness: a resumed succeeded loop with an undeclared pull request adds no checkpoint write.
test("a no-op resume of an undeclared loop writes nothing", async () => {
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
        spawn: childDouble({ undeclared: 42 }).spawn,
        installSignal: false,
      },
    });
    const checkpoint = batchPaths(runsRoot).loop(prepared.id, 1);
    const before = await stat(checkpoint, { bigint: true });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps: { ...fakeGitDeps, notifier: noNotify, installSignal: false },
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.summary.loops[0]).toMatchObject({ prUndeclared: 42 });
    expect((await stat(checkpoint, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: an exit 4 loop names its undeclared pull request and the next action in status.
test("batch status names the undeclared pull request of an exit 4 loop", async () => {
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
        spawn: childDouble({ exitCode: 4, undeclared: 42 }).spawn,
        installSignal: false,
      },
    });
    const status = await readBatchStatus({ runsRoot, id: prepared.id });
    expect(status.loops[0]).toMatchObject({
      status: "needs-owner",
      reason: "pr-head-unresolved",
      pr: null,
      prUndeclared: 42,
    });
    expect(status.loops[0].nextAction).toContain("pull request 42");
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

// One Git-backed preparation serves every default-root case. Each case takes the shared
// repository, base, and settings, and derives only its own batch id and default root.
let sharedDefault;
async function defaultRootCase(overrides = {}) {
  if (!sharedDefault) {
    const repo = await batchRepo();
    sharedDefault = await preparedFor(repo, [1], { workTreeRoot: undefined });
  }
  const id = newBatchId();
  const prepared = {
    ...sharedDefault,
    id,
    issues: [1],
    workTreeRoot: join(dirname(sharedDefault.repo), `${basename(sharedDefault.repo)}-batch-${id}`),
    ...overrides,
  };
  const runsRoot = await mkdtemp(join(tmpdir(), "batch-root-runs-"));
  roots.push(runsRoot);
  return { prepared, runsRoot };
}

const linkType = process.platform === "win32" ? "junction" : "dir";

// Usefulness: a completed batch leaves no empty default root beside the repository (issue #2022).
test("a completed batch removes the empty default work-tree root", async () => {
  const { prepared, runsRoot } = await defaultRootCase();
  await mkdir(prepared.workTreeRoot, { recursive: true });
  try {
    const { exitCode, summary } = await runBatch({
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
    expect(exitCode).toBe(0);
    expect(summary.status).toBe("completed");
    await expect(stat(prepared.workTreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: the same root removal runs when the batch reaches failed, not only completed.
test("a failed batch removes the empty default work-tree root", async () => {
  const { prepared, runsRoot } = await defaultRootCase();
  await mkdir(prepared.workTreeRoot, { recursive: true });
  try {
    const { exitCode, summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        createWorkTree: async () => {
          throw new Error("the base branch is gone");
        },
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(exitCode).toBe(1);
    expect(summary.status).toBe("failed");
    await expect(stat(prepared.workTreeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: the removal is a no-op while a kept loop work tree holds the default root.
test("a kept loop work tree keeps the default work-tree root", async () => {
  const { prepared, runsRoot } = await defaultRootCase();
  try {
    const { summary } = await runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        createWorkTree: async ({ workTree, branch }) => {
          await mkdir(workTree, { recursive: true });
          await writeFile(join(workTree, "kept.txt"), "kept\n");
          return { path: workTree, canonicalPath: workTree, dev: "1", ino: "1", branch };
        },
        cleanupLoop: async () => ({ removed: false, reason: "the work tree is not clean" }),
        spawn: childDouble().spawn,
        installSignal: false,
      },
    });
    expect(summary.status).toBe("completed");
    expect((await stat(join(prepared.workTreeRoot, "issue-1", "kept.txt"))).isFile()).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a root the user passed is never removed, empty or holding an entry.
test("a root passed with --work-tree-root stays empty or holding an entry", async () => {
  const userEmpty = await mkdtemp(join(tmpdir(), "batch-user-root-"));
  const userHolds = await mkdtemp(join(tmpdir(), "batch-user-root-"));
  roots.push(userEmpty, userHolds);
  await writeFile(join(userHolds, "owner-file.txt"), "kept\n");
  const empty = await defaultRootCase({ workTreeRoot: userEmpty });
  const holds = await defaultRootCase({ workTreeRoot: userHolds });
  try {
    const statuses = [];
    for (const { prepared, runsRoot } of [empty, holds]) {
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
      statuses.push(summary.status);
    }
    expect(statuses).toEqual(["completed", "completed"]);
    expect((await stat(userEmpty)).isDirectory()).toBe(true);
    expect((await stat(join(userHolds, "owner-file.txt"))).isFile()).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a resume of a batch that was already completed changes no file system state
// (issue #2022 review). The removal belongs to the transition into completed or failed.
test("a no-op resume keeps an empty default work-tree root", async () => {
  const { prepared, runsRoot } = await defaultRootCase();
  await mkdir(prepared.workTreeRoot, { recursive: true });
  try {
    const deps = {
      ...fakeGitDeps,
      notifier: noNotify,
      spawn: childDouble().spawn,
      installSignal: false,
    };
    const first = await runBatch({ prepared, runsRoot, gh: fakeGh(), deps });
    expect(first.summary.status).toBe("completed");
    await mkdir(prepared.workTreeRoot, { recursive: true });
    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh(),
      deps,
    });
    expect(resumed.summary.status).toBe("completed");
    expect((await stat(prepared.workTreeRoot)).isDirectory()).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: a link at the derived default path is not proof that the batch used the default
// root (issue #2022 review). A user root that it links to is never deleted.
test("a link from the default path to a --work-tree-root directory keeps that directory", async () => {
  const userRoot = await mkdtemp(join(tmpdir(), "batch-user-root-"));
  roots.push(userRoot);
  const { prepared, runsRoot } = await defaultRootCase({ workTreeRoot: userRoot });
  const derived = join(dirname(prepared.repo), `${basename(prepared.repo)}-batch-${prepared.id}`);
  await symlink(userRoot, derived, linkType);
  roots.push(derived);
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
    expect(summary.status).toBe("completed");
    expect((await stat(userRoot)).isDirectory()).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: the lstat guard applies to the derived default path itself, so a link there is
// never removed and its target is never followed (issue #2022 review).
test("a link at the derived default root is never removed or followed", async () => {
  const { prepared, runsRoot } = await defaultRootCase();
  const target = await mkdtemp(join(tmpdir(), "batch-link-target-"));
  roots.push(target);
  await symlink(target, prepared.workTreeRoot, linkType);
  roots.push(prepared.workTreeRoot);
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
    expect(summary.status).toBe("completed");
    expect((await lstat(prepared.workTreeRoot)).isSymbolicLink()).toBe(true);
    expect((await stat(target)).isDirectory()).toBe(true);
  } finally {
    await cleanupRepo();
  }
});

const summaryOf = (notDone) => ({
  changed: "a",
  verified: "b",
  deferred: "none",
  notDone,
  open: "none",
});

// Runs issues 1 and 2, one child double each, and returns the summary and the status read.
async function runTwo(options, gh = fakeGh()) {
  const prepared = await waitPrepared([1, 2]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const children = options.map((option) => childDouble(option));
  const spawn = (call) => {
    const next = children.find((child) => child.calls.length === 0) ?? children[0];
    return next.spawn(call);
  };
  try {
    const run = await runBatch({
      prepared,
      runsRoot,
      gh,
      deps: { ...fakeGitDeps, notifier: noNotify, spawn, installSignal: false },
    });
    return { summary: run.summary, status: await readBatchStatus({ runsRoot, id: prepared.id }) };
  } finally {
    await cleanupRepo();
  }
}

// Usefulness: issue #2049 — a succeeded loop whose own finish summary reports the item not done is
// named partial in the summary and in batch status, and the batch does not read as fully
// delivered. Not redundant: no other test covers the partial marker of a loop entry.
test("a succeeded loop whose finish summary reports the item not done is marked partial", async () => {
  const notDone = "the issue is not fixed and the pull request does not close it";
  const { summary, status } = await runTwo(
    [
      { pr: 11, summary: summaryOf(notDone) },
      { pr: 12, summary: summaryOf("none") },
    ],
    fakeGh({
      closingReferences: new Map([
        [11, [1]],
        [12, [2]],
      ]),
    }),
  );

  expect(summary.status).toBe("completed");
  expect(summary.loops[0]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["not-done"],
  });
  expect(summary.loops[1].partial).toBeUndefined();
  expect(status.loops[0]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["not-done"],
  });
  expect(status.loops[1].partial).toBeUndefined();
  expect(status.completion).toEqual({ status: "completed", complete: false });
});

// Usefulness: issue #2049 — a batch whose loops all report notDone none shows no marker and keeps
// its completion flag. Not redundant: it guards against marking every succeeded loop.
test("a batch whose loops all report notDone none shows no partial marker", async () => {
  const { summary, status } = await runTwo(
    [
      { pr: 11, summary: summaryOf("none") },
      { pr: 12, summary: summaryOf("none") },
    ],
    fakeGh({
      closingReferences: new Map([
        [11, [1]],
        [12, [2]],
      ]),
    }),
  );

  expect(summary.loops.map((loop) => loop.partial)).toEqual([undefined, undefined]);
  expect(status.loops.map((loop) => loop.partial)).toEqual([undefined, undefined]);
  expect(status.completion).toEqual({ status: "completed", complete: true });
});

// Usefulness: issue #2049 — a succeeded issue loop whose pull request closes another issue is
// named partial, apart from the loop whose pull request closes its own issue. Not redundant: it
// covers the closing-reference read that the report alone cannot give.
test("a succeeded loop whose pull request does not close its issue is marked partial", async () => {
  const { summary, status } = await runTwo(
    [
      { pr: 11, summary: summaryOf("none") },
      { pr: 12, summary: summaryOf("none") },
    ],
    fakeGh({
      closingReferences: new Map([
        [11, [99]],
        [12, [2]],
      ]),
    }),
  );

  expect(summary.status).toBe("completed");
  expect(summary.loops[0]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["pull-request-does-not-close-issue"],
  });
  expect(summary.loops[1].partial).toBeUndefined();
  expect(status.loops[0].partial).toBe(true);
  expect(status.completion).toEqual({ status: "completed", complete: false });
});

// Usefulness: issue #2049 review — an issue loop that succeeds with no pull request holds no
// delivery evidence, so it is marked partial. Not redundant: the earlier cases all hold a
// pull request.
test("a succeeded issue loop with no pull request is marked partial", async () => {
  const { summary, status } = await runTwo(
    [{ summary: summaryOf("none") }, { pr: 12, summary: summaryOf("none") }],
    fakeGh({ closingReferences: new Map([[12, [2]]]) }),
  );

  expect(summary.loops[0]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["no-pull-request"],
  });
  expect(summary.loops[1].partial).toBeUndefined();
  expect(status.completion).toEqual({ status: "completed", complete: false });
});

// Usefulness: issue #2049 review — an unreadable closing-reference read never reads as fully
// delivered, and it logs the warning that the ADR promises. Not redundant: the earlier partial
// cases all hold readable evidence.
test("an unreadable closing-reference read marks the loop partial and warns", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { summary, status } = await runTwo(
      [
        { pr: 11, summary: summaryOf("none") },
        { pr: 12, summary: summaryOf("none") },
      ],
      fakeGh({ unreadableClosures: new Set([11]), closingReferences: new Map([[12, [2]]]) }),
    );

    expect(summary.loops[0]).toMatchObject({
      status: "succeeded",
      partial: true,
      partialReasons: ["closing-reference-unread"],
    });
    expect(summary.loops[1].partial).toBeUndefined();
    expect(status.completion).toEqual({ status: "completed", complete: false });
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some(
        (line) =>
          line.includes("warn") &&
          line.includes("closing-reference read") &&
          line.includes("pull request 11"),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
});

// Usefulness: issue #2049 review — a reply with no closing reference list is unreadable, so it
// warns and never reads as delivered. Not redundant: it covers the malformed reply apart from the
// failed call.
test("a reply without a closing reference list marks the loop partial and warns", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { summary } = await runTwo(
      [
        { pr: 11, summary: summaryOf("none") },
        { pr: 12, summary: summaryOf("none") },
      ],
      fakeGh({ malformedClosures: new Set([11]), closingReferences: new Map([[12, [2]]]) }),
    );

    expect(summary.loops[0]).toMatchObject({
      status: "succeeded",
      partial: true,
      partialReasons: ["closing-reference-unread"],
    });
    const lines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some(
        (line) =>
          line.includes("warn") &&
          line.includes("closing-reference read") &&
          line.includes("no closing reference list"),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
});

// Usefulness: issue #2049 review — a commit message that closes the issue is the same delivery
// evidence that the eligibility check reads, so the loop is not marked partial. Not redundant: it
// covers evidence outside the closing reference list.
test("a commit message that closes the issue counts as delivery evidence", async () => {
  const { summary, status } = await runTwo(
    [
      { pr: 11, summary: summaryOf("none") },
      { pr: 12, summary: summaryOf("none") },
    ],
    fakeGh({
      closingReferences: new Map([
        [11, []],
        [12, []],
      ]),
      closureCommits: new Map([
        [11, ["Fix the parser\n\nFixes #1"]],
        [12, ["Refs #2"]],
      ]),
    }),
  );

  expect(summary.loops[0].partial).toBeUndefined();
  expect(summary.loops[1]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["pull-request-does-not-close-issue"],
  });
  expect(status.completion).toEqual({ status: "completed", complete: false });
});

// Usefulness: issue #2049 review — a body keyword counts on a pull request whose base is not the
// default branch, as it does for the eligibility check. Not redundant: it covers the body evidence
// apart from the commit evidence.
test("a body keyword on a non-default base counts as delivery evidence", async () => {
  const { summary } = await runTwo(
    [
      { pr: 11, summary: summaryOf("none") },
      { pr: 12, summary: summaryOf("none") },
    ],
    fakeGh({
      closingReferences: new Map([
        [11, []],
        [12, []],
      ]),
      closureBody: new Map([
        [11, "This fixes #1."],
        [12, "This touches #2."],
      ]),
      closureBase: new Map([
        [11, "release"],
        [12, "release"],
      ]),
    }),
  );

  expect(summary.loops[0].partial).toBeUndefined();
  expect(summary.loops[1]).toMatchObject({
    status: "succeeded",
    partial: true,
    partialReasons: ["pull-request-does-not-close-issue"],
  });
});

// Usefulness: issue #2049 review — the delivery check reads only the final attempt's pull request,
// so an undeclared pull request that the final attempt cleared is no delivery evidence. Not
// redundant: it covers a resumed loop with a stale checkpoint value.
test("a resumed loop reads no cleared undeclared pull request for delivery", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ steps: 1, undeclared: 42, hold: true });
  const second = childDouble({ steps: 1, summary: summaryOf("none") });
  const closingCalls = [];
  const gh = fakeGh({ closingReferences: new Map([[42, [1]]]), closingCalls });
  try {
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh,
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(first);
    controller.abort();
    await run;
    expect((await readLoop(runsRoot, prepared.id, 1)).prUndeclared).toBe(42);

    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh,
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: second.spawn, installSignal: false },
    });

    expect(resumed.summary.loops[0]).toMatchObject({
      status: "succeeded",
      pr: null,
      prUndeclared: null,
      partial: true,
      partialReasons: ["no-pull-request"],
    });
    expect(closingCalls).not.toContain(42);
  } finally {
    await cleanupRepo();
  }
});

// Usefulness: issue #2049 review — a legacy issue checkpoint without a kind still gets the closing
// read, as the rest of the batch code treats a missing kind as an issue item. Not redundant: it
// covers the legacy checkpoint shape.
test("a legacy issue checkpoint without a kind still reads the closing reference", async () => {
  const prepared = await waitPrepared([1]);
  const runsRoot = join(prepared.workTreeRoot, "runs");
  const first = childDouble({ steps: 1, hold: true });
  const second = childDouble({ steps: 1, pr: 11, summary: summaryOf("none") });
  const closingCalls = [];
  try {
    const controller = new AbortController();
    const run = runBatch({
      prepared,
      runsRoot,
      gh: fakeGh(),
      deps: {
        ...fakeGitDeps,
        notifier: noNotify,
        spawn: first.spawn,
        installSignal: false,
        signal: controller.signal,
      },
    });
    await waitForLaunch(first);
    controller.abort();
    await run;
    await updateLoop(runsRoot, prepared.id, 1, (loop) => {
      const next = { ...loop };
      delete next.kind;
      return next;
    });

    const resumed = await runBatch({
      prepared: { ...prepared, resume: true },
      runsRoot,
      gh: fakeGh({ closingReferences: new Map([[11, [1]]]), closingCalls }),
      deps: { ...fakeGitDeps, notifier: noNotify, spawn: second.spawn, installSignal: false },
    });

    expect(resumed.summary.loops[0]).toMatchObject({ status: "succeeded", pr: 11 });
    expect(resumed.summary.loops[0].partial).toBeUndefined();
    expect(closingCalls).toContain(11);
  } finally {
    await cleanupRepo();
  }
});
