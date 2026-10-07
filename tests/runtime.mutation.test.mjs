import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { execa } from "execa";
import { MutationError } from "../src/lib/snapshot.mjs";
import { runLoop, runProbeTurn } from "../src/runtime.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

// 16. Usefulness: verifies reviewer mutation is detected, fatal, and does not revert changes.
test("reviewer mutation is detected and fatal", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "run_reviewer", prompt: "mutate" })];
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(repo, "leak.txt"), "leak\n");
        return "done";
      },
    ]);

    await expect(
      runLoop({
        task: "Task 16",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
      }),
    ).rejects.toThrow(MutationError);

    // No-revert rule: mutated file still exists on disk
    const s = await execa("git", ["status", "--porcelain"], { cwd: repo });
    expect(s.stdout).toContain("leak.txt");
  } finally {
    await removePath(repo);
  }
});

// 17. Usefulness: verifies orchestrator mutation is detected and fatal.
test("orchestrator mutation is detected and fatal", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      async () => {
        await writeFile(join(repo, "orch-leak.txt"), "leak\n");
        return JSON.stringify({ action: "run_worker", prompt: "go" });
      },
    ]);

    await expect(
      runLoop({
        task: "Task 17",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      }),
    ).rejects.toThrow(MutationError);
  } finally {
    await removePath(repo);
  }
});

// 18. Usefulness: verifies mutation on failed turn prioritizes MutationError.
test("reviewer mutation on failed turn is fatal MutationError", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "run_reviewer", prompt: "mutate and throw" })];
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(repo, "leak.txt"), "leak\n");
        throw new Error("inner error");
      },
    ]);

    await expect(
      runLoop({
        task: "Task 18",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
      }),
    ).rejects.toThrow(MutationError);
  } finally {
    await removePath(repo);
  }
});

// 19. Usefulness: verifies reviewer mutation by commit is detected via <HEAD>.
test("reviewer mutation by commit is fatal MutationError", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "run_reviewer", prompt: "commit" })];
    const reviewerAdapter = scripted([
      async () => {
        await writeFile(join(repo, "init.txt"), "mutated commit\n");
        await execa("git", ["add", "init.txt"], { cwd: repo });
        await execa("git", ["commit", "-m", "illegal"], { cwd: repo });
        return "done";
      },
    ]);

    await expect(
      runLoop({
        task: "Task 19",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
      }),
    ).rejects.toThrow(MutationError);
  } finally {
    await removePath(repo);
  }
});

// 20. Usefulness: verifies mutation during the orchestrator repair turn (first response malformed,
// repair turn writes a file) is fatal, so every orchestrator turn stays mutation-checked.
test("orchestrator mutation on repair turn is fatal MutationError", async () => {
  const repo = await createTempRepo();
  try {
    const orchAdapter = scripted([
      "malformed response with no JSON",
      async () => {
        await writeFile(join(repo, "repair-leak.txt"), "leak\n");
        return JSON.stringify({ action: "run_worker", prompt: "go" });
      },
    ]);

    await expect(
      runLoop({
        task: "Task 20",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: orchAdapter, work: scripted([]), rev: scripted([]) },
      }),
    ).rejects.toThrow(MutationError);
  } finally {
    await removePath(repo);
  }
});

// 21. Usefulness: verifies a reviewer-turn snapshot failure is fatal, not a recoverable child error.
test("reviewer snapshot failure is fatal when agent succeeds", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "run_reviewer", prompt: "break snapshot" })];
    const reviewerAdapter = scripted([
      async () => {
        await rm(join(repo, ".git"), { recursive: true, force: true });
        return "done";
      },
    ]);

    await expect(
      runLoop({
        task: "Task 21",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
      }),
    ).rejects.toMatchObject({ name: "SnapshotError" });
  } finally {
    await removePath(repo);
  }
});

// 22. Usefulness: verifies a failed reviewer-turn snapshot wins over the agent error and attaches it as cause.
test("reviewer snapshot failure is fatal when agent also fails", async () => {
  const repo = await createTempRepo();
  try {
    const orchReplies = [JSON.stringify({ action: "run_reviewer", prompt: "break snapshot" })];
    const agentError = new Error("reviewer crashed");
    const reviewerAdapter = scripted([
      async () => {
        await rm(join(repo, ".git"), { recursive: true, force: true });
        throw agentError;
      },
    ]);

    await expect(
      runLoop({
        task: "Task 22",
        cwd: repo,
        maxSteps: 5,
        roles: {
          orchestrator: { kind: "orch", sessionId: null },
          worker: { kind: "work", sessionId: null },
          reviewer: { kind: "rev", sessionId: null },
        },
        agents: { orch: scripted(orchReplies), work: scripted([]), rev: reviewerAdapter },
      }),
    ).rejects.toMatchObject({
      name: "SnapshotError",
      cause: agentError,
    });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: the resolved-model probe is a child turn, so a probe that changes the work tree halts with
// the same MutationError as any read-only turn, and a clean probe leaves the tree alone (#394).
test("a probe turn that changes the work tree is a fatal mutation", async () => {
  const repo = await createTempRepo();
  try {
    const state = { kind: "rev", sessionId: null };
    const seen = [];
    const clean = scripted([
      async (_state, _prompt, options) => {
        seen.push(options);
        return "OK";
      },
    ]);
    await runProbeTurn({ agents: { rev: clean }, state, roleName: "reviewer", cwd: repo });
    expect(seen[0]).toMatchObject({ readOnly: true, role: "reviewer", cwd: repo });

    const leak = scripted([
      async () => {
        await writeFile(join(repo, "probe-leak.txt"), "leak\n");
        return "OK";
      },
    ]);
    await expect(
      runProbeTurn({ agents: { rev: leak }, state, roleName: "reviewer", cwd: repo }),
    ).rejects.toThrow(MutationError);
  } finally {
    await removePath(repo);
  }
});
