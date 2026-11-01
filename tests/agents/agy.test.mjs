import { expect, test, vi } from "vite-plus/test";
import { runAgy } from "../../src/agents/agy.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logWarn } from "../../src/lib/log.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));
vi.mock("../../src/lib/log.mjs", () => ({
  logWarn: vi.fn(),
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

// Usefulness: verifies that a resumed turn whose stderr reports a missing conversation, with exit 0
// and a new conversation id in the result, stores the new id, warns, and marks the state so the
// runtime can give the new conversation the role preamble (issues #360, #396).
test("agy adopts the new conversation when the resumed one is missing", async () => {
  vi.mocked(logWarn).mockClear();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-new", response: "ok" }),
    stderr: 'warning: conversation "conv-old" not found',
  });
  const state = { kind: "agy", sessionId: "conv-old", model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).resolves.toBe("ok");
  expect(state.sessionId).toBe("conv-new");
  expect(state.conversationReplaced).toBe(true);
  expect(logWarn).toHaveBeenCalledOnce();
  expect(vi.mocked(logWarn).mock.calls[0][0]).toContain("conv-old");
});

// Usefulness: verifies a different id without the missing-conversation text is adopted, warned, and
// marked like the missing case, because the new conversation has no preamble either way (issue #396).
test("agy adopts and warns on a different conversation id with no warning text", async () => {
  vi.mocked(logWarn).mockClear();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-new", response: "ok" }),
    stderr: "",
  });
  const state = { kind: "agy", sessionId: "conv-old", model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).resolves.toBe("ok");
  expect(state.sessionId).toBe("conv-new");
  expect(state.conversationReplaced).toBe(true);
  expect(logWarn).toHaveBeenCalledOnce();
});

// Usefulness: verifies a resumed turn that keeps its conversation id logs nothing, marks nothing,
// and clears a mark left by an earlier turn, so only a replaced conversation triggers the preamble.
test("agy leaves a resumed conversation unmarked", async () => {
  vi.mocked(logWarn).mockClear();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "ok" }),
    stderr: "",
  });
  const state = {
    kind: "agy",
    sessionId: "conv-1",
    conversationReplaced: true,
    model: null,
    effort: null,
  };
  await runAgy(state, "p", { cwd: "/dir" });
  expect(state.sessionId).toBe("conv-1");
  expect(state.conversationReplaced).toBeUndefined();
  expect(logWarn).not.toHaveBeenCalled();
});

// Usefulness: verifies a first turn has no conversation to lose, so its new id is never a replacement.
test("agy does not mark a first turn as a replaced conversation", async () => {
  vi.mocked(logWarn).mockClear();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "ok" }),
    stderr: "",
  });
  const state = { kind: "agy", sessionId: null, model: null, effort: null };
  await runAgy(state, "p", { cwd: "/dir" });
  expect(state.conversationReplaced).toBeUndefined();
  expect(logWarn).not.toHaveBeenCalled();
});

// Usefulness: verifies a first turn whose result names a conversation but carries no response keeps
// the conversation id, as issue #360 requires of every adapter error path. agy has no later
// validation that fails the turn, so the id and an empty response both reach the caller.
test("agy keeps the conversation id of a first turn with no response text", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ conversation_id: "conv-empty", status: "SUCCESS" }),
    stderr: "",
  });

  const state = { kind: "agy", sessionId: null, model: null, effort: null };
  await expect(runAgy(state, "p", { cwd: "/dir" })).resolves.toBe("");
  expect(state.sessionId).toBe("conv-empty");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("agy rejects %s as the reported session id", async (_name, id) => {
  const stdout = JSON.stringify({ conversation_id: id, response: "ok" });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "agy", sessionId: null, model: null, effort: null };
  await expect(runAgy(first, "p", { cwd: "/dir" })).rejects.toThrow(
    "Antigravity did not return a conversation_id.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "agy", sessionId: "stored", model: null, effort: null };
  await expect(runAgy(resumed, "p", { cwd: "/dir" })).rejects.toThrow(
    "Antigravity did not return a conversation_id.",
  );
  expect(resumed.sessionId).toBe("stored");
});

// Usefulness: verifies the reviewer-only Codex sandbox input changes no agy invocation, so the
// opt-in reaches Codex alone (issue #421).
test("agy invocation is identical with the reviewer sandbox input on and off", async () => {
  vi.mocked(exec).mockClear();
  const reply = {
    stdout: JSON.stringify({ conversation_id: "conv-1", response: "ok" }),
    stderr: "",
  };
  vi.mocked(exec).mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  const turn = (extra) =>
    runAgy({ kind: "agy", sessionId: null, model: null, effort: null }, "p", {
      cwd: "/dir",
      readOnly: true,
      ...extra,
    });

  await turn({});
  await turn({ sandbox: "workspace-write" });

  const [off, on] = vi.mocked(exec).mock.calls;
  expect(on).toEqual(off);
});

// The machine line that agy 1.4.12 printed on stderr of a failed turn against a local 529 server
// (issue #1323). The `short_error` prefix is the CLI's own text, and the provider message follows
// it. No live capacity reply confirmed the line.
const agyErrorLine = (shortError, extra = {}) =>
  `AGY_ERROR: ${JSON.stringify({
    short_error: shortError,
    retryable: false,
    error_id: "e-1",
    ...extra,
  })}`;

const agyCapacityLine = agyErrorLine(
  "UNAVAILABLE (code 529): The model API is currently overloaded.",
);

const agyFailedTurn = (overrides = {}) =>
  Object.assign(new Error("agy exited with code 3."), {
    exitCode: 3,
    stdout: JSON.stringify({
      conversation_id: "conv-cap",
      status: "ERROR",
      response: "",
      error: "The model API is currently overloaded.",
      finished_reason: "error",
    }),
    stderr: `error: The model API is currently overloaded.\n${agyCapacityLine}\n`,
    timedOut: false,
    isCanceled: false,
    isTerminated: false,
    ...overrides,
  });

const agyState = () => ({ kind: "agy", sessionId: null, model: null, effort: null });

// Usefulness: verifies requirement "each adapter with a sourced capacity signal is marked transient" (issue #1323), so a parent retries without reading the error text.
test("agy marks a provider capacity failure transient", async () => {
  vi.mocked(exec).mockRejectedValueOnce(agyFailedTurn());

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies "consecutive capacity failures stay marked" (issue #1323): two capacity lines still mark the turn.
test("agy keeps the mark when consecutive lines are capacity", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    agyFailedTurn({ stderr: `${agyCapacityLine}\n${agyCapacityLine}\n` }),
  );

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies requirement "only the terminal failure decides" (issue #1323): a later error with another cause must not make a parent retry a real fault.
test("agy does not mark a capacity line that a later error replaces", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    agyFailedTurn({
      stderr: `${agyCapacityLine}\n${agyErrorLine("UNAVAILABLE (code 401): bad key")}\n`,
    }),
  );

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies a non-capacity reply is never marked (issue #1323), because a wrong mark makes a parent retry a real fault.
test.each([
  ["a provider 503", agyErrorLine("UNAVAILABLE (code 503): service unavailable")],
  ["an auth failure", agyErrorLine("UNAVAILABLE (code 401): bad key")],
  [
    "the code inside the provider message",
    agyErrorLine("UNAVAILABLE (code 503): retry (code 529)"),
  ],
])("agy does not mark %s transient", async (_name, line) => {
  vi.mocked(exec).mockRejectedValueOnce(agyFailedTurn({ stderr: `${line}\n` }));

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies a capacity reply that a turn did not fail on is never marked (issue #1323): a timeout, a cancel, and a signal fail for another reason.
test.each([
  ["a timeout", { timedOut: true }],
  ["a cancel", { isCanceled: true }],
  ["a signal", { isTerminated: true }],
])("agy does not mark a capacity line on %s", async (_name, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(agyFailedTurn(overrides));

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies a broken final AGY_ERROR line keeps the earlier capacity line decisive (issue #1323), so a truncated tail cannot hide an overload.
test("agy keeps the mark when the final line is truncated", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    agyFailedTurn({ stderr: `${agyCapacityLine}\nAGY_ERROR: {"short_error":"UNAVAIL` }),
  );

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies the adapter reads stderr only (issue #1323): model output that quotes the capacity line never marks a turn.
test("agy does not mark a capacity line that only the model output holds", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    agyFailedTurn({
      stdout: JSON.stringify({ conversation_id: "conv-cap", status: "ERROR", error: "boom" }),
      stderr: `error: boom\n${agyCapacityLine}\n`.replace("AGY_ERROR:", "note AGY_ERROR:"),
    }),
  );

  const caught = await runAgy(agyState(), "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});
