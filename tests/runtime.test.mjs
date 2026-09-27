import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ExecError } from "../src/lib/exec.mjs";
import { MutationError, reviewedState, snapshot } from "../src/lib/snapshot.mjs";
import { runLoop } from "../src/runtime.mjs";
import { setVerbose } from "../src/lib/log.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

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
    await removePath(repo);
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
    await removePath(repo);
  }
});

// 2b. Usefulness: verifies the headless reviewer result prompt carries the
// runtime reviewed state, so the headless parent sees the same identity the
// interactive envelope records (issue #217).
test("headless reviewer result carries the runtime reviewed state", async () => {
  const repo = await createTempRepo();
  try {
    const expected = reviewedState(await snapshot(repo));
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "inspect repo" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];
    const orchAdapter = scripted(orchReplies);
    const reviewerAdapter = scripted(["reviewer inspected"]);

    const result = await runLoop({
      task: "Task 2b",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    const resultPromptText = orchAdapter.recorded[1].prompt;
    expect(resultPromptText).toContain(`"head": "${expected.head}"`);
    expect(resultPromptText).toContain(`"digest": "${expected.digest}"`);
    expect(resultPromptText).toContain('"clean": true');
    expect(resultPromptText).toContain('"exact": true');
  } finally {
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
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
    await removePath(repo);
  }
});

// 23. Usefulness: verifies issue #26 acceptance — a timed-out child produces a log line naming the role and "timed out".
test("timed-out child logs a line naming the role and timed out", async () => {
  const repo = await createTempRepo();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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

    const result = await runLoop({
      task: "Task 23",
      cwd: repo,
      maxSteps: 5,
      timeout: 10,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    const lines = errorSpy.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines.some((line) => line.includes("reviewer") && line.includes("timed out"))).toBe(
      true,
    );
  } finally {
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// 24. Usefulness: verifies issue #26 acceptance — with the debug gate on, snapshot debug lines appear
// around each reviewer and orchestrator turn (reviewer/orchestrator turns are mutation-checked).
test("verbose mode logs snapshot debug lines around reviewer and orchestrator turns", async () => {
  const repo = await createTempRepo();
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  setVerbose(true);
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review please" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ];

    const result = await runLoop({
      task: "Task 24",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted(["reviewed"]) },
    });

    expect(result.exitCode).toBe(0);
    const lines = logSpy.mock.calls.map((call) => call.join(" "));
    expect(lines.some((line) => line.includes("snapshot") && line.includes("reviewer"))).toBe(true);
    expect(lines.some((line) => line.includes("snapshot") && line.includes("orchestrator"))).toBe(
      true,
    );
  } finally {
    setVerbose(false);
    logSpy.mockRestore();
    await removePath(repo);
  }
});

// 25. Usefulness: verifies issue #26 review fix — a mutation event is logged exactly once (at the
// detection site), not duplicated by the orchestrator failure log.
test("mutation is logged exactly once", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const runCase = async (action) => {
    errorSpy.mockClear();
    const repo = await createTempRepo();
    try {
      const mutate = async () => {
        await writeFile(join(repo, "mutated.txt"), "mutated\n");
        return "done";
      };
      const orchReply =
        action === "run_reviewer"
          ? [JSON.stringify({ action: "run_reviewer", prompt: "review" })]
          : [null];
      const reviewerReply = action === "run_reviewer" ? [mutate] : [];

      await expect(
        runLoop({
          task: "Task 25",
          cwd: repo,
          maxSteps: 5,
          roles: {
            orchestrator: { kind: "orch", sessionId: null },
            worker: { kind: "work", sessionId: null },
            reviewer: { kind: "rev", sessionId: null },
          },
          agents: {
            // Orchestrator mutation case: orchestrator itself writes a file then dispatches.
            orch:
              action === "run_reviewer"
                ? scripted(orchReply)
                : scripted([
                    async () => {
                      await writeFile(join(repo, "mutated.txt"), "mutated\n");
                      return JSON.stringify({ action: "run_worker", prompt: "go" });
                    },
                  ]),
            work: scripted([]),
            rev: scripted(reviewerReply),
          },
        }),
      ).rejects.toThrow(MutationError);
    } finally {
      await removePath(repo);
    }
    const lines = errorSpy.mock.calls.map((call) => call.join(" "));
    expect(lines.filter((line) => line.includes("Mutation detected during"))).toHaveLength(1);
  };

  await runCase("run_reviewer");
  await runCase("run_worker");
});

// 26. Usefulness: verifies one invocation event per CLI call, including the orchestrator repair
// turn, carrying the usage the adapter exposed (issue #47).
test("runtime emits an invocation event per CLI call with adapter usage", async () => {
  const repo = await createTempRepo();
  try {
    const finish = JSON.stringify({
      action: "finish",
      summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
    });
    const withUsage = (reply, cost) => (state) => {
      state.usage = { totalCostUsd: cost };
      return reply;
    };
    const orchAdapter = scripted([
      withUsage(JSON.stringify({ action: "run_worker", prompt: "go" }), 0.1),
      withUsage("not json at all", 0.2),
      withUsage(finish, 0.3),
    ]);
    const workerAdapter = scripted(["worker done"]);
    const events = [];

    const result = await runLoop({
      task: "Task 26",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    const invocations = events.filter((e) => e.type === "invocation");
    expect(invocations).toEqual([
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 0,
        usage: { totalCostUsd: 0.1 },
      },
      { type: "invocation", role: "worker", status: "ok", stepsUsed: 1 },
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.2 },
      },
      {
        type: "invocation",
        role: "orchestrator",
        status: "ok",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.3 },
      },
    ]);
    // Usage is consumed per invocation and never lingers on the role state.
    expect(orchAdapter.recorded.length).toBe(3);
  } finally {
    await removePath(repo);
  }
});

// 27. Usefulness: verifies a failed CLI call still produces an invocation event with error status.
test("runtime emits an error invocation event when the CLI call throws", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "fail" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted([
      () => {
        throw new Error("worker crashed");
      },
    ]);
    const events = [];

    await runLoop({
      task: "Task 27",
      cwd: repo,
      maxSteps: 5,
      roles: {
        orchestrator: { kind: "orch", sessionId: null },
        worker: { kind: "work", sessionId: null },
        reviewer: { kind: "rev", sessionId: null },
      },
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    const workerInvocations = events.filter((e) => e.type === "invocation" && e.role === "worker");
    expect(workerInvocations).toEqual([
      { type: "invocation", role: "worker", status: "error", stepsUsed: 1 },
    ]);
  } finally {
    await removePath(repo);
  }
});

// 28. Usefulness: verifies usage an adapter exposed before throwing reaches the error invocation
// event and is cleared from the role state (issue #47).
test("runtime keeps adapter usage on an error invocation event and clears it from state", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      JSON.stringify({ action: "run_worker", prompt: "fail" }),
      JSON.stringify({
        action: "finish",
        summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
      }),
    ]);
    const workerAdapter = scripted([
      (state) => {
        state.usage = { totalCostUsd: 0.05 };
        throw new Error("worker crashed after spending");
      },
    ]);
    const roles = {
      orchestrator: { kind: "orch", sessionId: null },
      worker: { kind: "work", sessionId: null },
      reviewer: { kind: "rev", sessionId: null },
    };
    const events = [];

    await runLoop({
      task: "Task 28",
      cwd: repo,
      maxSteps: 5,
      roles,
      agents: { orch: orchAdapter, work: workerAdapter, rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    const workerInvocations = events.filter((e) => e.type === "invocation" && e.role === "worker");
    expect(workerInvocations).toEqual([
      {
        type: "invocation",
        role: "worker",
        status: "error",
        stepsUsed: 1,
        usage: { totalCostUsd: 0.05 },
      },
    ]);
    expect(roles.worker.usage).toBeUndefined();
  } finally {
    await removePath(repo);
  }
});

const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };
const REVIEW_ACCEPT = [
  "Conclusion: the state passes.",
  "Why: changes match the task.",
  "Blockers: none.",
  "Checks: npm test",
  "Verdict: accept",
].join("\n");
const REVIEW_REJECT = [
  "Conclusion: the state fails.",
  "Why: the change is incomplete.",
  "Blockers: none.",
  "Verdict: reject",
].join("\n");

function gateRoles() {
  return {
    orchestrator: { kind: "orch", sessionId: null },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
}

// 29. Usefulness: verifies --require-accept refuses a finish with no later
// reviewer accept, then allows the finish once a reviewer accepts that state
// (issue #234).
test("--require-accept refuses a finish until a reviewer accepts", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "Task 29",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// 30. Usefulness: verifies the gate treats a reviewer reject as not accepted, and
// a later reviewer accept on the same state allows the finish (issue #234).
test("--require-accept treats a reviewer reject as not accepted", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "re-review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_REJECT, REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "Task 30",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
  } finally {
    await removePath(repo);
  }
});

// 31. Usefulness: verifies the gate maps a run with no worker turn to review-only:
// the finish follows the report whatever the verdict (issue #234).
test("--require-accept allows a review-only finish with no worker turn", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 31",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([REVIEW_REJECT]) },
    });

    expect(result.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 32. Usefulness: verifies a repeated finish that still lacks a reviewer accept
// ends the run instead of spinning (issue #234).
test("--require-accept aborts a repeated refused finish", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 32",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
  } finally {
    await removePath(repo);
  }
});

// 33. Usefulness: verifies --require-accept refuses a finish with no child turn
// and allows a review-only finish once a reviewer report exists (issue #234).
test("--require-accept requires a reviewer report when no worker turn ran", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([REVIEW_REJECT]);

    const result = await runLoop({
      task: "Task 33",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(1);
  } finally {
    await removePath(repo);
  }
});

// 34. Usefulness: verifies a reviewer reply with no Verdict line does not satisfy
// the gate: process success never implies acceptance (issue #234).
test("--require-accept does not accept a reviewer reply without a verdict", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 34",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted(["reviewed, but the verdict line is missing"]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
  } finally {
    await removePath(repo);
  }
});

// 35. Usefulness: verifies a later reviewer failure does not clear an earlier
// reviewer report when no worker turn ran, so "at least one reviewer report"
// holds (issue #234).
test("--require-accept keeps an earlier reviewer report after a later failure", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "first review" }),
      JSON.stringify({ action: "run_reviewer", prompt: "second review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const reviewerAdapter = scripted([
      REVIEW_REJECT,
      () => {
        throw new Error("reviewer crashed");
      },
    ]);

    const result = await runLoop({
      task: "Task 35",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
    });

    expect(result.exitCode).toBe(0);
    expect(reviewerAdapter.recorded.length).toBe(2);
  } finally {
    await removePath(repo);
  }
});

// 36. Usefulness: verifies a finish refused when the step budget is already used
// ends on the refusal path with exit 1, records the refusal event, and never
// attempts the corrective child dispatch that the used budget cannot run
// (issues #248, #247).
test("--require-accept returns the refusal exit 1 when no step budget remains", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
    ];
    const reviewerAdapter = scripted([]);
    const events = [];

    const result = await runLoop({
      task: "Task 36",
      cwd: repo,
      maxSteps: 1,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: reviewerAdapter,
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("reviewer accept");
    expect(reviewerAdapter.recorded.length).toBe(0);
    const refusals = events.filter((e) => e.type === "refusal");
    expect(refusals).toEqual([
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
    ]);
    const finishActionIndex = events.findIndex(
      (e) => e.type === "action" && e.action.action === "finish",
    );
    expect(events[finishActionIndex + 1].type).toBe("refusal");
  } finally {
    await removePath(repo);
  }
});

// 37. Usefulness: verifies each refused finish under --require-accept is recorded
// as a refusal event that follows the refused action, carries the reason and the
// step count, and appears once per refusal (issue #247).
test("--require-accept records a refused finish as a refusal event", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 37",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    const refusals = events.filter((e) => e.type === "refusal");
    expect(refusals).toEqual([
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
      {
        type: "refusal",
        reason:
          "no reviewer accept with a Checks line on the latest changed state after a worker turn",
        stepsUsed: 1,
      },
    ]);
    const finishActionIndexes = events
      .map((event, index) =>
        event.type === "action" && event.action.action === "finish" ? index : -1,
      )
      .filter((index) => index !== -1);
    expect(finishActionIndexes).toHaveLength(2);
    for (const index of finishActionIndexes) {
      expect(events[index + 1].type).toBe("refusal");
    }
  } finally {
    await removePath(repo);
  }
});

// 38. Usefulness: verifies the gate treats a reviewer accept with no Checks line
// as not accepted, matching the parent prompt rule (issue #217, issue #218).
test("--require-accept treats an accept without a Checks line as not accepted", async () => {
  const repo = await createTempRepo();
  try {
    const acceptNoChecks = [
      "Conclusion: the state passes.",
      "Why: changes match the task.",
      "Blockers: none.",
      "Verdict: accept",
    ].join("\n");
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];

    const result = await runLoop({
      task: "Task 38",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([acceptNoChecks]),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("Checks");
  } finally {
    await removePath(repo);
  }
});

// 39. Usefulness: verifies a finish that reports an unresolved PR-head compare
// records a distinct `unresolved-compare` event and still exits 0 with the
// summary, so the recorded finish no longer reads as a verified finish (#266).
test("finish with unresolvedCompare records an unresolved-compare event", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [JSON.stringify({ action: "finish", summary, unresolvedCompare: true })];
    const events = [];

    const result = await runLoop({
      task: "Task 39",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summary);
    // The headless CLI maps this flag to its own exit code, so the loop must
    // report it on the result and not only as an event (#279).
    expect(result.unresolvedCompare).toBe(true);
    const unresolved = events.filter((e) => e.type === "unresolved-compare");
    expect(unresolved).toEqual([{ type: "unresolved-compare", stepsUsed: 0 }]);
    const finishActionIndex = events.findIndex(
      (e) => e.type === "action" && e.action.action === "finish",
    );
    expect(events[finishActionIndex + 1].type).toBe("unresolved-compare");
  } finally {
    await removePath(repo);
  }
});

// 40. Usefulness: pins the accepted gap for #286. A PR-work finish that records
// the unresolved compare under `notDone` and `open` and omits the marker leaves
// no machine signal: exit 0, the summary, and no unresolved-compare event, which
// a consumer cannot tell from a verified finish. The free text is the only trace,
// so this pins the limit as deliberate instead of letting it drift unnoticed.
test("a PR finish that omits unresolvedCompare reads as verified", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const orchReplies = [JSON.stringify({ action: "finish", summary })];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 40 through PR 40.",
      cwd: repo,
      maxSteps: 5,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(summary);
    expect(result.unresolvedCompare).toBe(false);
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// 41. Usefulness: verifies a finish that carries the marker emits no
// unresolved-compare event while the --require-accept gate refuses it, and
// emits exactly one once a reviewer accept allows the finish, so the event
// tracks the accepted finish rather than the marker alone (#234, #266).
test("--require-accept emits the marker event only on the accepted finish", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 41",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker changed"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "refusal")).toHaveLength(1);
    expect(events.filter((e) => e.type === "unresolved-compare")).toEqual([
      { type: "unresolved-compare", stepsUsed: 2 },
    ]);
  } finally {
    await removePath(repo);
  }
});

// 42. Usefulness: verifies a real review-only finish (a reviewer turn, no
// worker turn) records the event when it carries the marker, so the marker
// path is covered outside the worker-plus-reviewer gate path (#234, #266).
test("review-only finish with the marker records the event", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "compared reviewed.head with the PR head",
      open: "PR head unresolved",
    };
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
    ];
    const events = [];

    const result = await runLoop({
      task: "Task 42",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      roles: gateRoles(),
      agents: { orch: scripted(orchReplies), work: scripted([]), rev: scripted([REVIEW_REJECT]) },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events.filter((e) => e.type === "unresolved-compare")).toEqual([
      { type: "unresolved-compare", stepsUsed: 1 },
    ]);
  } finally {
    await removePath(repo);
  }
});

// Answers the `--require-ci` gate the way the shared `checkCi` gate reads `gh`:
// the PR view, the repository slug, the two required-check sources, and the
// check runs and commit statuses GitHub evaluates. `headRefOid` is the PR head
// the gate compares with the reviewed commit.
function ciGateGh(headRefOid, calls = []) {
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (key.includes("pr view 42")) {
      return json({
        headRefOid,
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        potentialMergeCommit: null,
        state: "OPEN",
      });
    }
    if (key.includes("repo view")) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (key.includes("rules/branches/main")) {
      return json([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
        },
      ]);
    }
    if (key.includes("branches/main/protection")) {
      return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (key.includes("/check-runs")) {
      return json([
        {
          check_runs: [
            {
              name: "ci (ubuntu-latest)",
              status: "completed",
              conclusion: "success",
              started_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]);
    }
    if (key.includes("/status")) {
      return json({ statuses: [] });
    }
    return { status: 1, stdout: "", stderr: `unmatched: ${key}` };
  };
}

const OTHER_HEAD = "1".repeat(40);

// 43. Usefulness: verifies the headless --require-ci gate resolves the PR head in
// the runtime: a finish whose PR head is not the reviewed commit is refused with
// the gate reason, recorded as a refusal event, and ends the run on exit 1
// (issue #293).
test("--require-ci refuses a finish whose PR head is not the reviewed commit", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 43 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: ciGateGh(OTHER_HEAD),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR head differs from the reviewed commit");
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toEqual([
      "the PR head differs from the reviewed commit",
      "the PR head differs from the reviewed commit",
    ]);
  } finally {
    await removePath(repo);
  }
});

// 44. Usefulness: verifies the same gate accepts the finish once the PR head is
// the reviewed commit, so the refusal above comes from the gate result and not
// from a gate that always refuses (issue #293).
test("--require-ci passes a finish whose PR head is the reviewed commit", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const calls = [];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 44 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: ciGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual(SUMMARY);
    expect(events.some((e) => e.type === "refusal")).toBe(false);
    expect(calls.some((key) => key.includes("pr view 42"))).toBe(true);
  } finally {
    await removePath(repo);
  }
});

// 45. Usefulness: verifies a worker turn after the reviewer turn clears the
// reviewed state the gate reads, so a commit made after the review cannot pass
// against the older reviewed head, matching the interactive gate (#293).
test("--require-ci refuses a finish after a worker turn follows the review", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const orchReplies = [
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 45 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: ciGateGh(head),
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker committed after the review"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
  } finally {
    await removePath(repo);
  }
});

// 46. Usefulness: verifies the gate refuses a finish that also records the
// unresolved compare, and does so without asking GitHub, because the gate
// resolves that compare and the marker would contradict it (issue #293, #281).
test("--require-ci refuses a finish that carries unresolvedCompare", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const head = (await snapshot(repo)).head;
    const calls = [];
    const events = [];

    const result = await runLoop({
      task: "PR work: address issue 46 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: ciGateGh(head, calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("unresolvedCompare cannot be combined with --require-ci");
    expect(calls).toEqual([]);
    expect(events.some((e) => e.type === "unresolved-compare")).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// 47. Usefulness: verifies a `gh` failure inside the gate refuses the finish
// instead of throwing out of the loop. The interactive path leaves the run active
// for a retry, and the headless run has none outside the refusal, so a throw
// would discard a run a second attempt could pass (#293).
test("--require-ci turns a gh failure into a refusal, not a throw", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const orchReplies = [
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ];
    const events = [];
    const failingGh = async (args) => {
      const key = args.join(" ");
      if (key.includes("pr view 42")) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return ciGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 47 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireCi: 42,
      gh: failingGh,
      roles: gateRoles(),
      agents: {
        orch: scripted(orchReplies),
        work: scripted(["worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT]),
      },
      onEvent: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("the PR gate could not be evaluated");
    expect(result.reason).toContain("Bad credentials");
    // Refusals, not a throw: the first gives the orchestrator its corrective
    // turn, and the second ends the run on the ordinary refusal path.
    expect(events.filter((e) => e.type === "refusal").map((e) => e.reason)).toEqual([
      expect.stringContaining("Bad credentials"),
      expect.stringContaining("Bad credentials"),
    ]);
    expect(events.filter((e) => e.type === "action")).toHaveLength(4);
  } finally {
    await removePath(repo);
  }
});

// 48. Usefulness: verifies a finish that breaks more than one rule is refused
// for every rule it breaks, in the order the interactive `role finish` checks
// them. One corrective turn is all the run grants, so a prompt that names only
// the first condition spends it on a condition the next refusal names instead
// (#293).
test("a finish that breaks several rules is refused for all of them", async () => {
  const repo = await createTempRepo();
  try {
    const summary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const calls = [];

    const result = await runLoop({
      task: "PR work: address issue 48 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: ciGateGh("1".repeat(40), calls),
      roles: gateRoles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
          JSON.stringify({ action: "finish", summary, unresolvedCompare: true }),
        ]),
        work: scripted([]),
        rev: scripted([]),
      },
    });

    expect(result.exitCode).toBe(1);
    // The marker, the missing reviewer report, and the PR head that is not the
    // reviewed commit, since no reviewer turn ran at all.
    expect(result.reason).toContain("unresolvedCompare cannot be combined with --require-ci");
    expect(result.reason).toContain("no reviewer report on the state");
    expect(result.reason).toContain("the latest reviewer turn has no reviewed state");
    expect(result.reason.indexOf("unresolvedCompare cannot")).toBeLessThan(
      result.reason.indexOf("no reviewer report"),
    );
  } finally {
    await removePath(repo);
  }
});

// 49. Usefulness: verifies an orchestrator that follows the refusal prompt
// reaches exit 0, for the marker refusal and for the gate refusal. The prompt is
// the run's only recovery, and a second refused finish with no child turn in
// between ends the run, so wording that omits the child turn is a dead end even
// when the wording is accurate (#293).
test("following a --require-ci refusal prompt reaches exit 0", async () => {
  const repo = await createTempRepo();
  try {
    const markerSummary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    // The orchestrator does exactly what the prompt says for each refusal: read
    // the conditions, dispatch the child turn the prompt names, then finish. A
    // prompt that said only "finish again" would end this run on exit 1, since a
    // second refused finish with no child turn in between ends the run (#293).
    const markerOrch = scripted([
      JSON.stringify({ action: "finish", summary: markerSummary, unresolvedCompare: true }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const markerResult = await runLoop({
      task: "PR work: address issue 49 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: ciGateGh((await snapshot(repo)).head),
      roles: gateRoles(),
      agents: { orch: markerOrch, work: scripted([]), rev: scripted([REVIEW_ACCEPT]) },
    });

    const markerPrompt = markerOrch.recorded[1].prompt;
    expect(markerPrompt).toContain("remove unresolvedCompare from the finish");
    expect(markerPrompt).toContain("Dispatch the reviewer");
    expect(markerPrompt).toContain("costs a step");
    expect(markerResult.exitCode).toBe(0);
    expect(markerResult.summary).toEqual(SUMMARY);

    // The gate refusal: the prompt names a worker turn, and the reviewer turn
    // after it re-establishes the reviewed state the gate reads.
    const head = (await snapshot(repo)).head;
    const gateHead = { current: OTHER_HEAD };
    const gateOrch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_worker", prompt: "push the change" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gateResult = await runLoop({
      task: "PR work: address issue 49 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      // The PR head matches the reviewed commit only after the second worker
      // turn, which is the recovery the prompt named.
      gh: async (args) => {
        const key = args.join(" ");
        const answer = ciGateGh(key.includes("pr view 42") ? gateHead.current : head);
        const result = await answer(args);
        if (key.includes("pr view 42")) {
          gateHead.current = head;
        }
        return result;
      },
      roles: gateRoles(),
      agents: {
        orch: gateOrch,
        work: scripted(["worker changed", "worker pushed the change"]),
        rev: scripted([REVIEW_ACCEPT, REVIEW_ACCEPT]),
      },
    });

    const gatePrompt = gateOrch.recorded[3].prompt;
    expect(gatePrompt).toContain("the PR head differs from the reviewed commit");
    expect(gatePrompt).toContain("Dispatch the reviewer");
    expect(gatePrompt).toContain("a worker turn resets the reviewed state to none");
    expect(gateResult.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 50. Usefulness: verifies a finish refused for the marker alone recovers with a
// re-finish and no child turn. Every other condition already passed, so a prompt
// that insists on a child turn would spend a step and start a review cycle the
// run did not need (#293).
test("a marker-only refusal is cleared by a re-finish with no child turn", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const markerSummary = {
      changed: "none",
      verified: "not verified: PR head unresolved",
      deferred: "none",
      notDone: "PR head unresolved",
      open: "PR head unresolved",
    };
    const orch = scripted([
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: markerSummary, unresolvedCompare: true }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const work = scripted([]);
    const rev = scripted([REVIEW_ACCEPT]);

    const result = await runLoop({
      task: "PR work: address issue 50 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh: ciGateGh(head),
      roles: gateRoles(),
      agents: { orch, work, rev },
    });

    expect(result.exitCode).toBe(0);
    // The prompt says so, and the run spends no step on it: one reviewer turn in
    // total, which is the one the first finish needed for the completion rule.
    expect(orch.recorded[2].prompt).toContain("needs no child turn");
    expect(orch.recorded[2].prompt).not.toContain("costs a step");
    // The edge case the ending names: nothing cleared the prior-refusal flag, so
    // a re-finish that is refused again ends the run.
    expect(orch.recorded[2].prompt).toContain("If the re-finish is refused again anyway");
    expect(work.recorded).toHaveLength(0);
    expect(rev.recorded).toHaveLength(1);
  } finally {
    await removePath(repo);
  }
});

// 51. Usefulness: verifies the prompt for a pending required check names the
// reviewer turn that clears it. A worker turn alone clears neither the reviewed
// state nor the completion rule, so a prompt naming only the worker turn spends
// an extra refusal and extra steps (#293).
test("a pending-check refusal is cleared by the reviewer turn its prompt names", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const check = { status: "in_progress" };
    const gateOrch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      // What the prompt names: a reviewer turn, not a worker turn.
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gh = async (args) => {
      const key = args.join(" ");
      if (key.includes("/check-runs")) {
        const answer = await ciGateGh(head)(args);
        if (check.status === "completed") {
          return answer;
        }
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              check_runs: [
                {
                  name: "ci (ubuntu-latest)",
                  status: check.status,
                  conclusion: null,
                  started_at: "2026-01-01T00:00:00Z",
                },
              ],
            },
          ]),
          stderr: "",
        };
      }
      return ciGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 51 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh,
      roles: gateRoles(),
      agents: {
        orch: gateOrch,
        work: scripted(["worker changed"]),
        // The check reports while the corrective reviewer turn runs, so the
        // finish after it passes on the same code with no further worker turn.
        rev: scripted([
          REVIEW_ACCEPT,
          () => {
            check.status = "completed";
            return REVIEW_ACCEPT;
          },
        ]),
      },
    });

    const prompt = gateOrch.recorded[3].prompt;
    expect(prompt).toContain('required check "ci (ubuntu-latest)" is pending');
    expect(prompt).toContain("Dispatch the reviewer to re-read the state");
    expect(result.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});

// 52. Usefulness: verifies the `gh`-failure prompt does not tell the
// orchestrator it is out of attempts, and names a reviewer turn as the retry.
// Any child turn clears the prior-refusal flag, so the run keeps its corrective
// turn while step budget remains (#293).
test("a gh-failure refusal does not claim the run is out of attempts", async () => {
  const repo = await createTempRepo();
  try {
    const head = (await snapshot(repo)).head;
    const failing = { on: true };
    const orch = scripted([
      JSON.stringify({ action: "run_worker", prompt: "work" }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const gh = async (args) => {
      const key = args.join(" ");
      if (failing.on && key.includes("pr view 42")) {
        return { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" };
      }
      return ciGateGh(head)(args);
    };

    const result = await runLoop({
      task: "PR work: address issue 52 through PR 42.",
      cwd: repo,
      maxSteps: 5,
      requireAccept: true,
      requireCi: 42,
      gh,
      roles: gateRoles(),
      agents: {
        orch,
        work: scripted(["worker changed"]),
        // The credential recovers while the corrective reviewer turn runs. The
        // second `gh` failure is not the run's last, because the corrective turn
        // cleared the prior-refusal flag.
        rev: scripted([
          REVIEW_ACCEPT,
          () => {
            failing.on = false;
            return REVIEW_ACCEPT;
          },
        ]),
      },
    });

    const prompt = orch.recorded[3].prompt;
    expect(prompt).toContain("the PR gate could not be evaluated");
    expect(prompt).toContain("The only retry you can make is a reviewer turn");
    expect(prompt).toContain("a worker turn resets that state to none");
    expect(prompt).not.toContain("one attempt left");
    expect(result.exitCode).toBe(0);
  } finally {
    await removePath(repo);
  }
});
