import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { exec } from "../src/lib/exec.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { runLoop } from "../src/runtime.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

vi.mock("../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

// Behavior of the opt-in Codex reviewer sandbox (issue #421, ADR 0019). Every role runs the real
// Codex adapter against a mocked CLI, so the assertions read the argv each turn received.

const READ_ONLY = 'sandbox_mode="read-only"';
const WORKSPACE_WRITE = 'sandbox_mode="workspace-write"';
const NETWORK_OFF = "sandbox_workspace_write.network_access=false";
const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };

const roles = {
  orchestrator: { kind: "codex", sessionId: null },
  worker: { kind: "codex", sessionId: null },
  reviewer: { kind: "codex", sessionId: null },
};

const reply = (text, thread) => ({
  stdout: [
    { type: "thread.started", thread_id: thread },
    { type: "item.completed", item: { type: "agent_message", text } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  stderr: "",
});

const repos = [];
afterEach(async () => {
  vi.mocked(exec).mockReset();
  for (const repo of repos.splice(0)) {
    await removePath(repo);
  }
});

/**
 * Runs orchestrator -> reviewer -> orchestrator(finish) and returns the argv and prompt of each
 * Codex call. `onReviewer(repo)` runs inside the reviewer turn.
 */
async function reviewerRun(options = {}, onReviewer = async () => {}) {
  const repo = await createTempRepo();
  repos.push(repo);
  const orchestratorTurns = [
    JSON.stringify({ action: "run_reviewer", prompt: "check it" }),
    JSON.stringify({ action: "finish", summary: SUMMARY }),
  ];
  const calls = [];
  vi.mocked(exec).mockImplementation(async (_cmd, args, opts) => {
    const isReviewer = opts.input.includes("Instructions:\ncheck it");
    calls.push({ role: isReviewer ? "reviewer" : "orchestrator", args, prompt: opts.input });
    if (isReviewer) {
      await onReviewer(repo);
      return reply("reviewed", "th-rev");
    }
    return reply(orchestratorTurns.shift(), "th-orch");
  });
  const run = () => runLoop({ task: "Task", cwd: repo, maxSteps: 5, roles, ...options });
  return { repo, calls, run };
}

const argsOf = (calls, role) => calls.filter((c) => c.role === role).map((c) => c.args.join(" "));

// Usefulness: verifies the default reviewer turn stays read-only, so the opt-in is the only way
// to widen it (issue #421).
test("with the opt-in off the Codex reviewer runs read-only", async () => {
  const { calls, run } = await reviewerRun();
  expect((await run()).exitCode).toBe(0);
  const [reviewer] = argsOf(calls, "reviewer");
  expect(reviewer).toContain(READ_ONLY);
  expect(reviewer).not.toContain("workspace-write");
});

// Usefulness: verifies the opt-in gives the reviewer turn the workspace-write sandbox with network
// off, while every orchestrator turn keeps the read-only invocation (issue #421, Guard 1).
test("with the opt-in on only the reviewer turn gets workspace-write, and the orchestrator stays read-only", async () => {
  const { calls, run } = await reviewerRun({ reviewerWorkspaceWrite: true });
  expect((await run()).exitCode).toBe(0);
  const [reviewer] = argsOf(calls, "reviewer");
  expect(reviewer).toContain(WORKSPACE_WRITE);
  expect(reviewer).toContain(NETWORK_OFF);
  expect(reviewer).not.toContain(READ_ONLY);
  const orchestrator = argsOf(calls, "orchestrator");
  expect(orchestrator).toHaveLength(2);
  for (const args of orchestrator) {
    expect(args).toContain(READ_ONLY);
    expect(args).not.toContain("workspace-write");
  }
});

// Usefulness: verifies the orchestrator repair turn also stays read-only with the opt-in on
// (issue #421, Guard 1).
test("with the opt-in on the orchestrator repair turn stays read-only", async () => {
  const repo = await createTempRepo();
  repos.push(repo);
  const turns = ["not json", JSON.stringify({ action: "finish", summary: SUMMARY })];
  const argvs = [];
  vi.mocked(exec).mockImplementation(async (_cmd, args) => {
    argvs.push(args.join(" "));
    return reply(turns.shift(), "th-orch");
  });
  await runLoop({
    task: "Task",
    cwd: repo,
    maxSteps: 5,
    roles,
    reviewerWorkspaceWrite: true,
  });
  expect(argvs).toHaveLength(2);
  for (const args of argvs) {
    expect(args).toContain(READ_ONLY);
    expect(args).not.toContain("workspace-write");
  }
});

// Usefulness: verifies the mutation check still wraps an opted-in reviewer turn, so an edit that
// the wider sandbox allows halts the run with a MutationError and stays on disk (issue #421).
test("with the opt-in on a reviewer edit halts the run with a MutationError", async () => {
  const { repo, run } = await reviewerRun({ reviewerWorkspaceWrite: true }, (dir) =>
    writeFile(join(dir, "leak.txt"), "leak\n"),
  );
  await expect(run()).rejects.toThrow(MutationError);
  await expect(readFile(join(repo, "leak.txt"), "utf8")).resolves.toBe("leak\n");
});

// Usefulness: verifies the reviewer prompt line appears only with the opt-in on, and names no
// repository-specific tool (issue #421, Guard 2).
test("the reviewer prompt carries the sandbox line only with the opt-in on", async () => {
  const off = await reviewerRun();
  await off.run();
  expect(off.calls.find((c) => c.role === "reviewer").prompt).not.toContain("workspace-write");

  const on = await reviewerRun({ reviewerWorkspaceWrite: true });
  await on.run();
  const prompt = on.calls.find((c) => c.role === "reviewer").prompt;
  expect(prompt).toContain("workspace-write");
  expect(prompt).toMatch(/local binary/);
  expect(prompt).not.toMatch(/pnpm|vitest|npm|yarn|node_modules/);
});
