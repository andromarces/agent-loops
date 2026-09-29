import { expect, test, vi } from "vitest";
import { runCodex } from "../../src/agents/codex.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies codex adapter sends exec, --json, and adds -c sandbox_mode="read-only" when readOnly is true on initial turn.
test("codex sends correct argv for initial turn with readOnly", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: events,
    stderr: "",
  });

  const state = { kind: "codex", sessionId: null, model: "gpt-4o", effort: "low" };
  const response = await runCodex(state, "prompt text", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("done");
  expect(state.sessionId).toBe("th-1");
  expect(exec).toHaveBeenCalledWith(
    "codex",
    [
      "exec",
      "-c",
      'sandbox_mode="read-only"',
      "--json",
      "-m",
      "gpt-4o",
      "-c",
      "model_reasoning_effort=low",
    ],
    { cwd: "/dir", input: "prompt text", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies codex adapter resumes session and adds -c sandbox_mode="read-only" when readOnly is true on resume.
test("codex resumes session with readOnly", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: "resumed ok" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: events,
    stderr: "",
  });

  const state = { kind: "codex", sessionId: "th-1", model: null, effort: null };
  const response = await runCodex(state, "resume prompt", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("resumed ok");
  expect(exec).toHaveBeenCalledWith(
    "codex",
    ["exec", "resume", "th-1", "-c", 'sandbox_mode="read-only"', "--json", "-"],
    { cwd: "/dir", input: "resume prompt", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies Codex turn-completed token counts reach transcript invocation events through state.usage.
test("codex maps turn-completed usage to the main loop", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-2" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 40,
        cache_write_input_tokens: 10,
        output_tokens: 30,
        reasoning_output_tokens: 20,
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };

  await runCodex(state, "prompt", { cwd: "/dir" });

  expect(state.usage).toEqual({
    mainLoop: {
      input_tokens: 120,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
      output_tokens: 30,
      reasoning_output_tokens: 20,
    },
  });
});

// Usefulness: verifies Codex turns without token events do not retain usage from a prior turn.
test("codex removes usage when no turn-completed usage exists", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-3" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = {
    kind: "codex",
    sessionId: null,
    model: null,
    effort: null,
    usage: { mainLoop: { input_tokens: 1 } },
  };

  await runCodex(state, "prompt", { cwd: "/dir" });

  expect(state).not.toHaveProperty("usage");
});

// Usefulness: verifies a failed first turn keeps the thread id that `thread.started` printed
// before the failure, so the next turn resumes it (issue #360).
test("codex keeps the thread id from a failed first turn", async () => {
  const stdout = [
    { type: "thread.started", thread_id: "th-failed" },
    { type: "turn.failed", error: { message: "boom" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("th-failed");
});

// Usefulness: verifies a failed resumed turn never changes the stored id.
test("codex keeps the stored thread id when a resumed turn fails", async () => {
  const stdout = JSON.stringify({ type: "thread.started", thread_id: "th-other" });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: "th-stored", model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("th-stored");
});

const MISSING =
  "Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)";

const missingFailure = (overrides = {}) =>
  Object.assign(new Error("codex exited with code 1."), {
    exitCode: 1,
    stdout: "",
    stderr: MISSING,
    ...overrides,
  });

// Usefulness: verifies the exact Codex stderr for the requested thread marks the error (issue #360).
test.each([
  ["the bare line", MISSING],
  ["one LF", `${MISSING}\n`],
  ["one CRLF", `${MISSING}\r\n`],
])("codex flags a resume of a missing thread with %s", async (_name, stderr) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure({ stderr }));

  const state = { kind: "codex", sessionId: "gone", model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.sessionMissing).toBe(true);
});

// Usefulness: verifies a failure that overlaps the missing-thread text is not marked, because a
// wrong mark reruns a real failure as a first turn and can repeat its edits (issue #360).
test.each([
  ["a first turn", null, {}],
  ["another thread id", "other", {}],
  ["a longer message", "gone", { stderr: `stream error: ${MISSING} retrying` }],
  [
    "an extra stderr line",
    "gone",
    {
      stderr: `Error: 429 Too Many Requests
${MISSING}`,
    },
  ],
  ["another error code", "gone", { stderr: MISSING.replace("-32600", "-32603") }],
  ["stdout events", "gone", { stdout: '{"type":"thread.started","thread_id":"gone"}' }],
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
  ["a model error", "gone", { stderr: "The 'x' model is not supported" }],
])("codex does not flag %s", async (_name, sessionId, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure(overrides));

  const state = { kind: "codex", sessionId, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.sessionMissing).toBeUndefined();
  if (sessionId) expect(state.sessionId).toBe(sessionId);
});
