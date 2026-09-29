import { expect, test, vi } from "vitest";
import { runAgy } from "../../src/agents/agy.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies agy adapter adds --mode plan when readOnly is true and passes input-format text.
test("agy sends --mode plan when readOnly is true", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "agy ok" }),
    stderr: "",
  });

  const state = { kind: "agy", sessionId: null, model: null, effort: null };
  const response = await runAgy(state, "agy prompt", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("agy ok");
  expect(state.sessionId).toBe("conv-1");
  expect(exec).toHaveBeenCalledWith(
    "agy",
    ["--input-format", "text", "--output-format", "json", "--mode", "plan"],
    { cwd: "/dir", input: "agy prompt", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies agy resumes conversation without --mode plan when readOnly is false.
test("agy resumes conversation with model and effort", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "agy resumed" }),
    stderr: "",
  });

  const state = { kind: "agy", sessionId: "conv-1", model: "gemini-pro", effort: "high" };
  const response = await runAgy(state, "follow up", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("agy resumed");
  expect(exec).toHaveBeenCalledWith(
    "agy",
    [
      "--input-format",
      "text",
      "--output-format",
      "json",
      "--model",
      "gemini-pro",
      "--effort",
      "high",
      "--conversation",
      "conv-1",
    ],
    { cwd: "/dir", input: "follow up", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies the adapter exposes main-loop token usage from the result as state.usage (issue #84).
test("agy exposes result usage on state", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({
      conversation_id: "conv-1",
      response: "agy ok",
      usage: {
        input_tokens: 18839,
        output_tokens: 106,
        thinking_tokens: 97,
        cache_read_tokens: 0,
        total_tokens: 18945,
      },
    }),
    stderr: "",
  });

  const state = { kind: "agy", sessionId: null, model: null, effort: null };
  await runAgy(state, "p", { cwd: "/dir", readOnly: false });

  expect(state.usage).toEqual({
    mainLoop: {
      input_tokens: 18839,
      output_tokens: 106,
      thinking_tokens: 97,
      cache_read_tokens: 0,
      total_tokens: 18945,
    },
  });
});

// Usefulness: verifies a result without usage fields leaves no stale usage on state (issue #84).
test("agy clears state.usage when the result carries no usage", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "done" }),
    stderr: "",
  });

  const state = {
    kind: "agy",
    sessionId: "conv-1",
    model: null,
    effort: null,
    usage: { stale: 1 },
  };
  await runAgy(state, "p", { cwd: "/dir", readOnly: false });

  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies a failed first turn that printed a non-empty conversation id keeps it, and
// an empty id (the model-error output) keeps nothing (issue #360).
test("agy keeps a non-empty conversation id from a failed first turn", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("agy exited with code 1."), {
      stdout: JSON.stringify({ conversation_id: "conv-failed", status: "ERROR", error: "boom" }),
      stderr: "",
    }),
  );
  const state = { kind: "agy", sessionId: null, model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("conv-failed");

  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("agy exited with code 1."), {
      stdout: JSON.stringify({ conversation_id: "", status: "ERROR", error: "bad model" }),
      stderr: "",
    }),
  );
  const empty = { kind: "agy", sessionId: null, model: null, effort: null };
  await expect(runAgy(empty, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(empty.sessionId).toBeNull();
});

// Usefulness: verifies a failure with unparseable stdout, such as a timeout, rethrows the exec error.
test("agy rethrows a failure with no parseable stdout", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("agy timed out after 5 seconds."), { stdout: "", stderr: "" }),
  );
  const state = { kind: "agy", sessionId: "conv-1", model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).rejects.toThrow("timed out");
  expect(state.sessionId).toBe("conv-1");
});

// Usefulness: verifies agy's behavior for a missing conversation: exit 0 with a warning and a new
// conversation. The adapter adopts the new id (issue #360).
test("agy adopts the new conversation when the resumed one is missing", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-new", response: "ok" }),
    stderr: 'warning: conversation "conv-old" not found',
  });
  const state = { kind: "agy", sessionId: "conv-old", model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).resolves.toBe("ok");
  expect(state.sessionId).toBe("conv-new");
});
