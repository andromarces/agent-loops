import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { readBatchStatus } from "../../src/batch/status.mjs";
import { updateLoop } from "../../src/batch/store.mjs";
import { newBatchId, runBatch } from "../../src/batch/supervisor.mjs";
import { removePath } from "../fs-helpers.mjs";
import {
  SUMMARY,
  childDouble,
  cleanupRepo,
  fakeGh,
  fakeGitDeps,
  noNotify,
  roots,
  waitForLaunch,
  waitPrepared,
} from "./supervisor-helpers.mjs";

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
    await waitForLaunch(child);
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
  await waitForLaunch(child);
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
