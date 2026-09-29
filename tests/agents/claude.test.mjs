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

// Usefulness: verifies a failed first turn that printed its session id keeps the id, so the next
// turn resumes that session and its edits (issue #360).
test("claude keeps the session id from a failed first turn", async () => {
  const stdout = JSON.stringify([
    { type: "system", subtype: "init", session_id: "s-failed" },
    { type: "result", is_error: true, session_id: "s-failed", result: "boom" },
  ]);
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("s-failed");
});

// Usefulness: verifies a failed resumed turn never changes the stored id.
test("claude keeps the stored session id when a resumed turn fails", async () => {
  const stdout = JSON.stringify({ type: "result", session_id: "s-other", result: "boom" });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: "s-stored", model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("s-stored");
});

// Usefulness: verifies a timeout with empty stdout leaves the id null (nothing to read).
test("claude leaves the session id null when a failed first turn printed nothing", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out after 5 seconds."), { stdout: "", stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("timed");
  expect(state.sessionId).toBeNull();
});

const MISSING = "No conversation found with session ID: gone";

const missingFailure = (overrides = {}) =>
  Object.assign(new Error("claude exited with code 1."), {
    exitCode: 1,
    stdout: "",
    stderr: MISSING,
    ...overrides,
  });

// Usefulness: verifies the exact Claude Code stderr for the requested id marks the error, so the
// runtime reruns the turn as a first turn (issue #360).
test.each([
  ["the bare line", MISSING],
  ["one LF", `${MISSING}\n`],
  ["one CRLF", `${MISSING}\r\n`],
])("claude flags a resume of a missing session with %s", async (_name, stderr) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure({ stderr }));

  const state = { kind: "claude", sessionId: "gone", model: null, effort: null };
  const caught = await runClaude(state, "p", { cwd: "/path" }).catch((e) => e);
  expect(caught.sessionMissing).toBe(true);
});

// Usefulness: verifies a failure that overlaps the missing-session text is not marked, because a
// wrong mark reruns a real failure as a first turn and can repeat its edits (issue #360).
test.each([
  ["a first turn", null, {}],
  ["another session id", "other", {}],
  ["a longer message", "gone", { stderr: `API Error: 529 overloaded. ${MISSING} upstream` }],
  [
    "an extra stderr line",
    "gone",
    {
      stderr: `Error: rate limit
${MISSING}`,
    },
  ],
  ["stdout output", "gone", { stdout: "partial result" }],
  ["a timeout", "gone", { timedOut: true }],
  ["a cancel", "gone", { isCanceled: true }],
  ["a signal", "gone", { isTerminated: true }],
  ["another exit code", "gone", { exitCode: 2 }],
  ["leading spaces", "gone", { stderr: ` ${MISSING}` }],
  ["trailing spaces", "gone", { stderr: `${MISSING} ` }],
  ["trailing spaces before the line ending", "gone", { stderr: `${MISSING} \n` }],
  ["a leading blank line", "gone", { stderr: `\n${MISSING}` }],
  ["a trailing blank line", "gone", { stderr: `${MISSING}\n\n` }],
  ["two CRLF line endings", "gone", { stderr: `${MISSING}\r\n\r\n` }],
  ["a bare carriage return", "gone", { stderr: `${MISSING}\r` }],
  ["a tab", "gone", { stderr: `${MISSING}\t` }],
  ["whitespace on stdout", "gone", { stdout: "\n" }],
  ["an auth failure", "gone", { stderr: "Invalid API key" }],
])("claude does not flag %s", async (_name, sessionId, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure(overrides));

  const state = { kind: "claude", sessionId, model: null, effort: null };
  const caught = await runClaude(state, "p", { cwd: "/path" }).catch((e) => e);
  expect(caught.sessionMissing).toBeUndefined();
});

// Usefulness: verifies a resumed turn never changes its id: a different id in the result is
// refused and the stored id stays, as in the Codex, Copilot, and opencode adapters (issue #360).
test("claude refuses a different session id on a resumed turn", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s-other", result: "ok" }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s-stored", model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not resume the expected session.",
  );
  expect(state.sessionId).toBe("s-stored");
});

// Usefulness: verifies a first turn whose result has no text keeps the reported session id, as
// issue #360 requires of every adapter error path. Claude has no later validation that fails the
// turn, so the id and an empty response both reach the caller.
test("claude keeps the session id of a first turn whose result has no text", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ type: "result", session_id: "s-empty" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).resolves.toBe("");
  expect(state.sessionId).toBe("s-empty");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("claude rejects %s as the reported session id", async (_name, id) => {
  const stdout = JSON.stringify({ session_id: id, result: "ok" });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(first, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not return a session_id.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "claude", sessionId: "stored", model: null, effort: null };
  await expect(runClaude(resumed, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not return a session_id.",
  );
  expect(resumed.sessionId).toBe("stored");
});
