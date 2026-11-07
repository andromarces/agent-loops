import { expect, test, vi } from "vite-plus/test";

// Answers `git` from memory (`cleanRepoGit` in git-helpers.mjs), so a case that asserts
// invocation events starts no `git` process.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { runLoop } from "../src/runtime.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { cleanRepoGit, createCleanRepoDir } from "./git-helpers.mjs";

// 26. Usefulness: verifies one invocation event per CLI call, including the orchestrator repair
// turn, carrying the usage the adapter exposed (issue #47).
test("runtime emits an invocation event per CLI call with adapter usage", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
    // A parsed closing block, so this case takes no repair turn.
    const workerAdapter = scripted(["Conclusion: worker done\nWhy: ok\nBlockers: none"]);
    const events = [];

    const result = await runLoop({
      task: "Task 26",
      cwd: repo,
      maxSteps: 5,
      copyLocalFiles: false,
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 27. Usefulness: verifies a failed CLI call still produces an invocation event with error status.
test("runtime emits an error invocation event when the CLI call throws", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
      copyLocalFiles: false,
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});

// 28. Usefulness: verifies usage an adapter exposed before throwing reaches the error invocation
// event and is cleared from the role state (issue #47).
test("runtime keeps adapter usage on an error invocation event and clears it from state", async () => {
  gitDouble.answer = cleanRepoGit;
  const repo = await createCleanRepoDir();
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
      copyLocalFiles: false,
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
    gitDouble.answer = null;
    await removePath(repo);
  }
});
