import { expect, test, vi } from "vitest";
import { runClaude } from "../../src/agents/claude.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies claude adapter sends -p, --output-format json, adds --permission-mode plan when
// readOnly is true, and disables the built-in Explore and Plan research subagents so a read-only turn
// does not spawn hidden subagents on the role model (issue #46).
test("claude sends correct argv for initial turn with readOnly", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: "claude-3-5", effort: null };
  const response = await runClaude(state, "test prompt", {
    cwd: "/path",
    readOnly: true,
  });

  expect(response).toBe("ok");
  expect(state.sessionId).toBe("s1");
  expect(exec).toHaveBeenCalledWith(
    "claude",
    ["-p", "--permission-mode", "plan", "--model", "claude-3-5", "--output-format", "json"],
    {
      cwd: "/path",
      input: "test prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" },
    },
  );
});

// Usefulness: verifies claude adapter passes --resume and effort on resume turn, and leaves the worker
// environment untouched so the worker keeps its research subagents.
test("claude resumes session with effort and readOnly false", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ session_id: "s1", type: "result", result: "done" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s1", model: null, effort: "high" };
  const response = await runClaude(state, "follow up", {
    cwd: "/path",
    readOnly: false,
  });

  expect(response).toBe("done");
  expect(exec).toHaveBeenCalledWith(
    "claude",
    ["-p", "--resume", "s1", "--effort", "high", "--output-format", "json"],
    { cwd: "/path", input: "follow up", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies the adapter exposes per-model usage, main-loop usage, and total cost from the
// result event as `state.usage`, so the transcript can attribute cost per invocation (issue #47).
test("claude exposes result usage on state", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({
      session_id: "s1",
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { "claude-opus-5": { inputTokens: 12, outputTokens: 6, costUSD: 0.01 } },
      total_cost_usd: 0.01,
    }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await runClaude(state, "p", { cwd: "/path", readOnly: false });

  expect(state.usage).toEqual({
    models: { "claude-opus-5": { inputTokens: 12, outputTokens: 6, costUSD: 0.01 } },
    mainLoop: { input_tokens: 10, output_tokens: 5 },
    totalCostUsd: 0.01,
  });
});

// Usefulness: verifies a result without usage fields leaves no stale usage on state.
test("claude clears state.usage when the result carries no usage", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ session_id: "s1", type: "result", result: "done" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s1", model: null, effort: null, usage: { stale: 1 } };
  await runClaude(state, "p", { cwd: "/path", readOnly: false });

  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies a failed CLI call that still printed a result event exposes its usage before
// the error propagates, so a failed invocation is not free in the transcript (issue #47).
test("claude exposes usage from stdout when the CLI exits non-zero", async () => {
  const stdout = JSON.stringify({
    session_id: "s1",
    type: "result",
    is_error: true,
    result: "boom",
    total_cost_usd: 0.02,
  });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null, usage: { stale: 1 } };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow(
    "claude exited with code 1.",
  );
  expect(state.usage).toEqual({ totalCostUsd: 0.02 });
});

// Usefulness: verifies a failure with unparseable stdout clears stale usage and rethrows.
test("claude clears stale usage when a failed call has no parseable stdout", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out after 5 seconds."), { stdout: "", stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null, usage: { stale: 1 } };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow(
    "timed out",
  );
  expect(state.usage).toBeUndefined();
});
