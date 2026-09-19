import { rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { ExecError } from "../src/lib/exec.mjs";
import { runLoop } from "../src/runtime.mjs";
import { createTempRepo, scripted } from "./runtime-helpers.mjs";

// 1. Usefulness: verifies orchestrator dispatches worker first.
test("orchestrator dispatches worker first", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "start work" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerReplies = ["worker did task"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted([]);

    const result = await runLoop({
      task: "Task 1",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(1);
    expect(workerAdapter.recorded[0].prompt).toContain("start work");
    expect(reviewerAdapter.recorded.length).toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 2. Usefulness: verifies orchestrator dispatches reviewer first.
test("orchestrator dispatches reviewer first", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "inspect repo" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["reviewer inspected"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 2",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
    expect(reviewerAdapter.recorded[0].prompt).toContain("inspect repo");
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 3. Usefulness: verifies reviewer findings go back to the worker with verbatim follow-up prompt.
test("reviewer findings go back to worker", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "first review" }),
      JSON.stringify({ action: "run_worker", prompt: "fix issues" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["found issue 1"];
    const workerReplies = ["fixed issue 1"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 3",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain("found issue 1");
    // Worker first turn wraps instructions
    expect(workerAdapter.recorded[0].prompt).toContain("fix issues");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 4. Usefulness: verifies reviewer reassesses without a worker turn (two run_reviewer).
test("reviewer reassesses without worker turn", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "rev 1" }),
      JSON.stringify({ action: "run_reviewer", prompt: "rev 2" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerReplies = ["ok 1", "ok 2"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(reviewerReplies);

    const result = await runLoop({
      task: "Task 4",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 5. Usefulness: verifies two consecutive worker turns.
test("two consecutive worker turns", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work 1" }),
      JSON.stringify({ action: "run_worker", prompt: "work 2" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerReplies = ["part 1 done", "part 2 done"];
    const orchAdapter = scripted(orchReplies);
    const workerAdapter = scripted(workerReplies);
    const reviewerAdapter = scripted([]);

    const result = await runLoop({
      task: "Task 5",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(2);
    // On second turn, prompt is verbatim
    expect(workerAdapter.recorded[1].prompt).toBe("work 2");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 6. Usefulness: verifies finish returns exit 0 and summary object.
test("finish returns exit 0 and summary object", async () => {
  const repo = await createTempRepo();
  try {
    const summaryObj = {
      changed: "all",
      verified: "tests",
      deferred: "none",
      notDone: "none",
      open: "none",
    };
    const orchReplies = [JSON.stringify({ action: "finish", summary: summaryObj })];
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 6",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summaryObj);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 7. Usefulness: verifies finish after rejecting findings with no worker turn.
test("finish after rejecting finding without worker turn", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({
        action: "finish",
        summary: {
          changed: "none",
          verified: "passed",
          deferred: "none",
          notDone: "none",
          open: "none",
        },
      }),
    ];
    const workerAdapter = scripted([]);
    const reviewerAdapter = scripted(["stale finding"]);

    const result = await runLoop({
      task: "Task 7",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(workerAdapter.recorded.length).toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 8. Usefulness: verifies abort returns exit 1 and reason.
test("abort returns exit 1 and reason", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "abort", reason: "spec contradiction" })];
    const result = await runLoop({
      task: "Task 8",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe("spec contradiction");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 9. Usefulness: verifies step limit enforcement (exit 2).
test("step limit reached refuses further child dispatch and returns exit 2", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "step 1" }),
      JSON.stringify({ action: "run_worker", prompt: "step 2" }),
      JSON.stringify({ action: "run_worker", prompt: "step 3" }),
    ];
    const workerAdapter = scripted(["r1", "r2", "r3"]);

    const result = await runLoop({
      task: "Task 9",
      cwd: repo,
      maxSteps: 2,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(2);
    expect(workerAdapter.recorded.length).toBe(2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 10. Usefulness: verifies last step allows finish for exit 0.
test("finish on stepsRemaining 0 returns exit 0", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "only step" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerAdapter = scripted(["done"]);

    const result = await runLoop({
      task: "Task 10",
      cwd: repo,
      maxSteps: 1,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 11. Usefulness: verifies separate session IDs across 3 roles on same kind.
test("separate session IDs preserved per role", async () => {
  const repo = await createTempRepo();
  try {
    let idGen = 0;
    const multiAgent = {
      async run(state) {
        if (!state.sessionId) {
          state.sessionId = `sess-${++idGen}`;
        }
        return JSON.stringify({
          action: "finish",
          summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
        });
      },
    };

    const roles = {
      orchestrator: { kind: "common", sessionId: null },
      worker: { kind: "common", sessionId: null },
      reviewer: { kind: "common", sessionId: null },
    };

    await runLoop({
      task: "Task 11",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: { common: multiAgent },
    });

    expect(roles.orchestrator.sessionId).toBe("sess-1");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 12. Usefulness: verifies child failure surfaces as error status and run continues.
test("child adapter failure surfaces to orchestrator", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "fail please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const workerAdapter = scripted([
      () => {
        throw new Error("worker crashed");
      },
    ]);
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 12",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain('"status": "error"');
    expect(orchAdapter.recorded[1].prompt).toContain("worker crashed");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 13. Usefulness: verifies child timeout surfaces as timeout message in error result.
test("child timeout surfaces with timeout message", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "hang please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const reviewerAdapter = scripted([
      () => {
        throw new ExecError("timeout", { timedOut: true });
      },
    ]);
    const orchAdapter = scripted(orchReplies);

    const result = await runLoop({
      task: "Task 13",
      cwd: repo,
      maxSteps: 5,
      timeout: 10,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(orchAdapter.recorded[1].prompt).toContain("reviewer timed out after 10 seconds");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 14. Usefulness: verifies orchestrator failure is fatal.
test("orchestrator failure throws fatal error", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      () => {
        throw new Error("orchestrator fatal error");
      },
    ]);

    await expect(
      runLoop({
        task: "Task 14",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      }),
    ).rejects.toThrow("orchestrator fatal error");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// 15. Usefulness: verifies cancel signal aborts loop.
test("cancel signal stops loop", async () => {
  const repo = await createTempRepo();
  const controller = new AbortController();
  try {
    const orchReplies = [JSON.stringify({ action: "run_worker", prompt: "wait signal" })];
    const workerAdapter = scripted([
      async () => {
        controller.abort();
        throw new ExecError("canceled", { isCanceled: true });
      },
    ]);

    await expect(
      runLoop({
        task: "Task 15",
        cwd: repo,
        maxSteps: 5,
        signal: controller.signal,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: workerAdapter, rev: scripted([]) },
      }),
    ).rejects.toMatchObject({ isCanceled: true });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
