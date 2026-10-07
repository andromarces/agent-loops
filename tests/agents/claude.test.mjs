import { expect, test, vi } from "vite-plus/test";
import { runClaude } from "../../src/agents/claude.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { verifyResolvedModels } from "../../src/lib/continuation.mjs";
import { runChild } from "../../src/runtime.mjs";

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

// Usefulness: verifies the adapter selects the first truthy id (an empty id is skipped), then validates
// that selected id, so a later valid id never rescues an invalid or mismatched selected one. A
// resumed turn keeps its stored id on every failure (issue #360).
test.each([
  ["invalid then valid, first turn", [42, "good"], null, "ERR_ID"],
  ["empty then valid, first turn", ["", "good"], null, "good"],
  ["valid then different valid, first turn", ["a", "b"], null, "a"],
  ["invalid then stored, resumed turn", [42, "stored"], "stored", "ERR_ID"],
  ["different then stored, resumed turn", ["other", "stored"], "stored", "ERR_MISMATCH"],
  ["stored then different, resumed turn", ["stored", "other"], "stored", "stored"],
  ["empty then stored, resumed turn", ["", "stored"], "stored", "stored"],
])("claude selects then validates the id: %s", async (_name, ids, requested, expected) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([
      ...ids.map((id) => ({ type: "system", session_id: id })),
      { type: "result", result: "ok" },
    ]),
    stderr: "",
  });
  const state = { kind: "claude", sessionId: requested, model: null, effort: null };
  const call = runClaude(state, "p", { cwd: "/path" });

  if (expected === "ERR_ID" || expected === "ERR_MISMATCH") {
    await expect(call).rejects.toThrow(
      expected === "ERR_ID"
        ? "Claude Code did not return a session_id."
        : "Claude Code did not resume the expected session.",
    );
    expect(state.sessionId).toBe(requested);
  } else {
    await expect(call).resolves.toBe("ok");
    expect(state.sessionId).toBe(expected);
  }
});

// Usefulness: verifies the reviewer-only Codex sandbox input changes no claude invocation, so the
// opt-in reaches Codex alone (issue #421).
test("claude invocation is identical with the reviewer sandbox input on and off", async () => {
  vi.mocked(exec).mockClear();
  const reply = { stdout: JSON.stringify({ session_id: "s1", result: "ok" }), stderr: "" };
  vi.mocked(exec).mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  const turn = (extra) =>
    runClaude({ kind: "claude", sessionId: null, model: null, effort: null }, "p", {
      cwd: "/dir",
      readOnly: true,
      ...extra,
    });

  await turn({});
  await turn({ sandbox: "workspace-write" });

  const [off, on] = vi.mocked(exec).mock.calls;
  expect(on).toEqual(off);
});

const resolved = async (result, state = { kind: "claude", sessionId: null, model: null }) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok", ...result }),
    stderr: "",
  });
  await runClaude(state, "p", { cwd: "/path" });
  return state.resolvedModel;
};

// Usefulness: --continue-from compares the model Claude Code resolved, so a result that names
// exactly one well-formed model in `modelUsage` records it.
test("claude records the one model its result reports as resolvedModel", async () => {
  expect(await resolved({ modelUsage: { "claude-opus-5-5": { inputTokens: 1 } } })).toBe(
    "claude-opus-5-5",
  );
});

// Usefulness: a false resolved model would refuse or pass a continuation wrongly, so several
// models (a subagent or helper ran), and every malformed `modelUsage` shape, mark the turn
// unresolved (null), which differs from "not reported" (the field absent).
test.each([
  ["several models", { modelUsage: { a: {}, b: {} } }],
  ["no modelUsage", {}],
  ["an empty object", { modelUsage: {} }],
  ["a string, whose characters are not keys", { modelUsage: "x" }],
  ["an array, whose indexes are not keys", { modelUsage: [{ inputTokens: 1 }] }],
  ["a null", { modelUsage: null }],
  ["a non-object entry", { modelUsage: { "claude-opus-5-5": 7 } }],
  ["a blank key", { modelUsage: { " ": {} } }],
  ["a key with whitespace", { modelUsage: { "claude opus": {} } }],
])("claude marks the turn unresolved for %s", async (_label, result) => {
  expect(await resolved(result)).toBeNull();
});

// Usefulness: the record describes the latest turn, so a turn with unreadable or ambiguous evidence
// replaces an earlier model with unresolved (null) instead of leaving a stale model that a later
// --continue-from would compare against (a false refusal of an unchanged model, or a false pass).
test.each([
  ["no modelUsage", {}],
  ["several models", { modelUsage: { a: {}, b: {} } }],
  ["a malformed modelUsage", { modelUsage: "x" }],
])("claude replaces the earlier resolvedModel with unresolved for %s", async (_label, result) => {
  const state = { kind: "claude", sessionId: null, model: null, resolvedModel: "claude-opus-5-5" };
  expect(await resolved(result, state)).toBeNull();
});

test("claude replaces the earlier resolvedModel when a turn names another single model", async () => {
  const state = { kind: "claude", sessionId: null, model: null, resolvedModel: "claude-opus-5-5" };
  expect(await resolved({ modelUsage: { "claude-opus-5-6": {} } }, state)).toBe("claude-opus-5-6");
});

// A failure as `exec` throws it: an ExecError that carries the output the child printed.
const execFailure = (overrides = {}) =>
  Object.assign(new Error("claude exited with code 1."), {
    name: "ExecError",
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    isCanceled: false,
    isTerminated: false,
    ...overrides,
  });

const failedState = () => ({
  kind: "claude",
  sessionId: null,
  model: null,
  resolvedModel: "claude-opus-5-5",
});

// Usefulness: the session ran on the model a failed turn names, so the record must follow it. Probe from
// review: a failed turn named B while the record kept A, so a probe of B refused and a probe of A passed.
test("claude records the model a failed turn names, replacing the earlier one", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({
      stdout: JSON.stringify({ session_id: "s1", modelUsage: { "claude-opus-5-6": {} } }),
    }),
  );
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("exited");
  expect(state.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: a turn that ran and named no single model may have run on another model, so the record
// becomes unresolved, on every failure path that writes the transcript: a non-zero exit with no or
// ambiguous output, a timeout, a cancel, a signal, and an exit 0 with output that does not parse.
test.each([
  ["a non-zero exit with no output", execFailure()],
  [
    "a non-zero exit with several models",
    execFailure({ stdout: JSON.stringify({ modelUsage: { a: {}, b: {} } }) }),
  ],
  ["a non-zero exit with output that is not JSON", execFailure({ stdout: "oops" })],
  ["a timeout", execFailure({ timedOut: true })],
  ["a cancel", execFailure({ isCanceled: true })],
  ["a signal", execFailure({ isTerminated: true, exitCode: undefined })],
])("claude marks the record unresolved after %s", async (_label, failure) => {
  vi.mocked(exec).mockRejectedValueOnce(failure);
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

test("claude marks the record unresolved after an exit 0 whose output does not parse", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: "not json", stderr: "" });
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: the record describes the session the role keeps. A session that cannot be established
// from the output (no session_id) may have run on any model, so the record is unresolved even when the
// output names one.
test("claude marks the record unresolved when the output names no session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ result: "ok", modelUsage: { "claude-opus-5-6": {} } }),
    stderr: "",
  });
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("session_id");
  expect(state.resolvedModel).toBeNull();
});

const namingB = (sessionId) => ({
  session_id: sessionId,
  result: "ok",
  modelUsage: { "claude-opus-5-6": {} },
});

// Usefulness: reported outcome. A resumed turn whose output is another session naming B keeps the
// original session id, so the record must not become B (a continuation would refuse A and accept B
// against the session the role keeps). The record is unresolved, so a continuation compares nothing.
test("claude does not record the model of a session the role does not keep", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-other")), stderr: "" });
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("did not resume");
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();

  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const now of ["claude-opus-5-5", "claude-opus-5-6"]) {
      const roles = {
        orchestrator: { kind: "codex", model: null, effort: null, resolvedModel: undefined },
        worker: { ...state, resolvedModel: state.resolvedModel },
        reviewer: { kind: "agy", model: null, effort: null, resolvedModel: undefined },
      };
      const probe = vi.fn(async (probed) => {
        probed.resolvedModel = now;
      });
      await expect(verifyResolvedModels(roles, { probe })).resolves.toBeUndefined();
      expect(probe).not.toHaveBeenCalled();
    }
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});

// Usefulness: a resumed turn that reports the retained session records its model, and a first turn
// records the session it adopts.
test("claude records the model of the retained or adopted session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-kept")), stderr: "" });
  const resumed = { ...failedState(), sessionId: "s-kept" };
  await runClaude(resumed, "p", { cwd: "/path" });
  expect(resumed.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-new")), stderr: "" });
  const first = failedState();
  await runClaude(first, "p", { cwd: "/path" });
  expect(first.sessionId).toBe("s-new");
  expect(first.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: the same session rule holds on a failed turn: only evidence of the kept session records,
// and a failed output with no session, or another one, is unresolved.
test.each([
  ["the retained session", "s-kept", "claude-opus-5-6"],
  ["another session", "s-other", null],
  ["no session", undefined, null],
])("claude failed turn that reports %s", async (_label, reported, expected) => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify({ ...namingB(reported) }) }),
  );
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBe(expected);
});

test("claude failed first turn records the model only with the session it adopts", async () => {
  vi.mocked(exec).mockRejectedValueOnce(execFailure({ stdout: JSON.stringify(namingB("s-new")) }));
  const adopted = failedState();
  await expect(runClaude(adopted, "p", { cwd: "/path" })).rejects.toThrow();
  expect(adopted.sessionId).toBe("s-new");
  expect(adopted.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify(namingB(undefined)) }),
  );
  const none = failedState();
  await expect(runClaude(none, "p", { cwd: "/path" })).rejects.toThrow();
  expect(none.sessionId).toBeNull();
  expect(none.resolvedModel).toBeNull();
});

// Usefulness: a process that never started ran no model, so the record stays: a spawn failure leaves
// the earlier state, and the earlier session is unchanged.
test("claude leaves the record alone when the process never started", async () => {
  vi.mocked(exec).mockRejectedValueOnce(execFailure({ exitCode: undefined }));
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBe("claude-opus-5-5");
});

// Usefulness: a resume of a missing session ran no model turn, but the rerun as a first turn does: the
// record follows the rerun, and a rerun that fails too leaves it unresolved, never the stale model.
test("claude record follows the rerun after a missing session", async () => {
  vi.mocked(exec)
    .mockRejectedValueOnce(missingFailure({ name: "ExecError", timedOut: false }))
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        session_id: "s2",
        result: "ok",
        modelUsage: { "claude-opus-5-6": {} },
      }),
      stderr: "",
    });
  const state = { ...failedState(), sessionId: "gone" };
  const outcome = await runChild({ role: state, roleName: "worker", prompt: "t", cwd: "/path" });
  expect(outcome.status).toBe("ok");
  expect(state.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec)
    .mockRejectedValueOnce(missingFailure({ name: "ExecError", timedOut: false }))
    .mockRejectedValueOnce(execFailure());
  const again = { ...failedState(), sessionId: "gone" };
  const failed = await runChild({ role: again, roleName: "worker", prompt: "t", cwd: "/path" });
  expect(failed.status).toBe("error");
  expect(again.resolvedModel).toBeNull();
});

const eventsOf = (...events) => ({ stdout: JSON.stringify(events), stderr: "" });
const systemEvent = (session_id) => ({ type: "system", subtype: "init", session_id });
const resultEvent = (session_id, models = { "claude-opus-5-6": {} }) => ({
  type: "result",
  ...(session_id === undefined ? {} : { session_id }),
  result: "ok",
  modelUsage: models,
});

// Usefulness: one consistent source. With an array of events, the model counts only when the event that
// carries it also names the session, and every event of the output names that one session. Reported
// fixture: a system event names the retained session while the result event with `modelUsage` names
// another, so the old selection kept session s-kept with the model of s-other.
test.each([
  ["a result event of another session", [systemEvent("s-kept"), resultEvent("s-other")]],
  ["a result event with no session", [systemEvent("s-kept"), resultEvent(undefined)]],
  ["a later event of another session", [resultEvent("s-kept"), systemEvent("s-other")]],
  ["a malformed session on one event", [resultEvent("s-kept"), { type: "x", session_id: 7 }]],
  [
    "two result events that disagree on the model",
    [resultEvent("s-kept"), resultEvent("s-kept", { "claude-opus-5-5": {} })],
  ],
])("claude records unresolved for %s in an array of events", async (_label, events) => {
  vi.mocked(exec).mockResolvedValueOnce(eventsOf(...events));
  const state = { ...failedState(), sessionId: "s-kept" };
  await runClaude(state, "p", { cwd: "/path" }).catch(() => {});
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: a normal single-session array still records the model of its result event.
test("claude records the model of a single-session array of events", async () => {
  vi.mocked(exec).mockResolvedValueOnce(eventsOf(systemEvent("s-kept"), resultEvent("s-kept")));
  const state = { ...failedState(), sessionId: "s-kept" };
  await runClaude(state, "p", { cwd: "/path" });
  expect(state.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockResolvedValueOnce(
    eventsOf(
      systemEvent("s-new"),
      resultEvent("s-new", { "claude-opus-5-6": {} }),
      resultEvent("s-new", { "claude-opus-5-6": {} }),
    ),
  );
  const first = failedState();
  await runClaude(first, "p", { cwd: "/path" });
  expect(first.sessionId).toBe("s-new");
  expect(first.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: the same single-source rule holds on a failed turn.
test("claude failed turn with mixed sessions in an array records unresolved", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify([systemEvent("s-kept"), resultEvent("s-other")]) }),
  );
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();

  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify([systemEvent("s-kept"), resultEvent("s-kept")]) }),
  );
  const same = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(same, "p", { cwd: "/path" })).rejects.toThrow();
  expect(same.resolvedModel).toBe("claude-opus-5-6");
});
