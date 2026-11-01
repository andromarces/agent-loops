import { expect, test, vi } from "vite-plus/test";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logDebug } from "../../src/lib/log.mjs";
import { errorEvent, textEvent } from "./opencode-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

// The dispatch path logs through several entry points, so the mock names them all
// rather than leaving the role and snapshot modules with undefined imports.
vi.mock("../../src/lib/log.mjs", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logInfoFull: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  setVerbose: vi.fn(),
  setLogsToStderr: vi.fn(),
}));

/** Runs root and temp repo for the dispatch test, removed after it. */

function stepFinishEvent({ input, output, reasoning, cacheRead = 0, cacheWrite = 0, cost }) {
  return JSON.stringify({
    type: "step_finish",
    sessionID: "sess-oc",
    part: {
      type: "step-finish",
      reason: "tool-calls",
      cost,
      tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    },
  });
}

// Usefulness: verifies a failed turn rethrows the same error instance with its operational fields
// intact, so the caller keeps timeout, cancel, and exit-code detail. The message is rebuilt from
// those fields, so neither the raw stdout nor the stderr that exec appended reaches the caller.
test("opencode rethrows a failed turn with its operational fields", async () => {
  const { ExecError } = await vi.importActual("../../src/lib/exec.mjs");
  const failure = new ExecError(
    "opencode exited with code 1.\n\nprovider.internal: Internal server error (status 500)",
    {
      command: "opencode",
      exitCode: 1,
      stdout: "",
      stderr: "provider.internal: Internal server error (status 500)",
      timedOut: true,
      isCanceled: true,
      isTerminated: true,
      signal: "SIGKILL",
    },
  );
  vi.mocked(exec).mockRejectedValueOnce(failure);

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir", role: "worker" }).catch(
    (err) => err,
  );

  expect(error).toBe(failure);
  expect(error.message).not.toContain("provider.internal");
  expect(error.name).toBe("ExecError");
  expect(error.timedOut).toBe(true);
  expect(error.isCanceled).toBe(true);
  expect(error.isTerminated).toBe(true);
  expect(error.command).toBe("opencode");
  expect(error.exitCode).toBe(1);
});

// Usefulness: verifies a failed opencode turn names the provider error event instead of the
// generic missing-text error, and still records the session id for a retry.
test("opencode surfaces a provider error event", async () => {
  const stdout = JSON.stringify({
    type: "error",
    sessionID: "sess-oc",
    error: { type: "provider.internal", message: "Internal server error", status: 500 },
  });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow(
    "opencode returned an error event: provider.internal: Internal server error (status 500)",
  );
  expect(state.sessionId).toBe("sess-oc");
});

// Usefulness: verifies an error event wins over partial text in the same turn, so a turn that
// streamed text before failing is not reported as a successful response.
test("opencode treats an error event as fatal even with partial text", async () => {
  const stdout = [
    JSON.stringify({ type: "text", sessionID: "sess-oc", part: { text: "partial" } }),
    JSON.stringify({ type: "error", sessionID: "sess-oc", error: { type: "provider.internal" } }),
  ].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow(
    "opencode returned an error event: provider.internal",
  );
});

// Usefulness: verifies one step_finish part per completed step is summed into mainLoop tokens and
// totalCostUsd, so a multi-step opencode turn reports full usage on its invocation event (issue #83).
test("opencode sums step_finish token and cost usage across steps", async () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "sess-oc", part: { type: "step-start" } }),
    stepFinishEvent({
      input: 100,
      output: 10,
      reasoning: 5,
      cacheRead: 20,
      cacheWrite: 2,
      cost: 0.01,
    }),
    JSON.stringify({ type: "step_start", sessionID: "sess-oc", part: { type: "step-start" } }),
    stepFinishEvent({ input: 200, output: 20, reasoning: 0, cacheRead: 30, cost: 0.02 }),
    textEvent("final reply"),
  ].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const response = await runOpenCode(state, "oc prompt", { cwd: "/dir" });

  expect(response).toBe("final reply");
  expect(state.usage).toEqual({
    mainLoop: {
      input: 300,
      output: 30,
      reasoning: 5,
      cache: { read: 50, write: 2 },
    },
    totalCostUsd: 0.03,
  });
});

// Usefulness: verifies a turn whose stream has no usage-carrying event still completes and leaves
// no usage key, so the invocation event stays clean (issue #83).
test("opencode leaves usage unset when the stream carries no step_finish usage", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("plain reply"), stderr: "" });

  const state = {
    kind: "opencode",
    sessionId: null,
    model: null,
    effort: null,
    usage: { stale: 1 },
  };
  const response = await runOpenCode(state, "oc prompt", { cwd: "/dir" });

  expect(response).toBe("plain reply");
  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies a turn that completed steps then failed still reports their usage, matching
// the Claude adapter and the runtime's error invocation event (issue #83).
test("opencode keeps step_finish usage when an error event follows", async () => {
  const stdout = [
    stepFinishEvent({ input: 50, output: 5, reasoning: 1, cost: 0.004 }),
    JSON.stringify({ type: "error", sessionID: "sess-oc", error: { type: "provider.internal" } }),
  ].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };

  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow(
    "opencode returned an error event: provider.internal",
  );
  expect(state.usage).toEqual({
    mainLoop: { input: 50, output: 5, reasoning: 1, cache: { read: 0, write: 0 } },
    totalCostUsd: 0.004,
  });
});

// Usefulness: verifies a failed CLI call that still printed step_finish parts exposes their usage
// before the error propagates, so a failed invocation is not free in the transcript (issue #83).
test("opencode exposes usage from stdout when the CLI exits non-zero", async () => {
  const stdout = stepFinishEvent({ input: 10, output: 2, reasoning: 0, cost: 0.001 });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("opencode exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = {
    kind: "opencode",
    sessionId: null,
    model: null,
    effort: null,
    usage: { stale: 1 },
  };
  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow(
    "opencode exited with code 1",
  );
  expect(state.usage).toEqual({
    mainLoop: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    totalCostUsd: 0.001,
  });
});

/**
 * Rejects the turn with a real ExecError carrying `fields`, and returns the error the adapter threw.
 * `fields` sets the ExecError operational fields, `options` the adapter options for the turn, and
 * `state` the state the turn records usage on.
 */

async function rejectTurnWith(
  { stdout = "", stderr = "", exitCode, ...fields },
  options = {},
  state = { kind: "opencode", sessionId: null, model: null, effort: null },
) {
  const { ExecError } = await vi.importActual("../../src/lib/exec.mjs");
  vi.mocked(exec).mockRejectedValueOnce(
    new ExecError(`opencode exited with code ${exitCode}.`, {
      command: "opencode",
      exitCode,
      stdout,
      stderr,
      ...fields,
    }),
  );
  return runOpenCode(state, "oc prompt", { cwd: "/dir", ...options }).catch((err) => err);
}

// A non-zero exit that names no provider error event reports this fixed line.
const NO_DETAIL = "opencode exited with code 1: no provider error event in the output";

// Usefulness: verifies an ordinary non-zero exit reports the exit code and the provider detail
// instead of the whole event stream, so the dispatch envelope names the cause and the exit code
// stays visible (issue #326). The message is asserted whole, so an implementation that appends the
// stream fails.
test("opencode reports the exit code and the last error event on a non-zero exit", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: [
      textEvent("work in progress"),
      errorEvent({
        type: "provider.invalid-output",
        message: "OpenAI Chat stream ended without finish_reason",
        status: 200,
      }),
    ].join("\n"),
  });

  expect(error.message).toBe(
    "opencode exited with code 1: provider.invalid-output: OpenAI Chat stream ended without finish_reason (status 200)",
  );
  expect(error.message).not.toContain("work in progress");
  expect(error.exitCode).toBe(1);
});

// Usefulness: verifies a stream that is truncated, unparseable, or free of error events yields a
// fixed message that still names the exit code, so a crash before the stream completes cannot dump
// a partial stream into the envelope or the state file (issue #326).
test("opencode bounds the message when a non-zero exit has no usable error event", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: [`{"type":"text","part":{"text":"${"X".repeat(5000)}`, "not json at all"].join("\n"),
  });

  expect(error.message).toBe(NO_DETAIL);
  expect(error.message).not.toContain("X".repeat(40));
});

// Usefulness: verifies stderr never reaches the envelope or the state file, because a CLI can print
// a secret there (issue #326).
test("opencode keeps stderr out of the message on a non-zero exit", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: "",
    stderr: `api key sk-secret-value rejected for project ${"E".repeat(2000)}`,
  });

  expect(error.message).toBe(NO_DETAIL);
  expect(error.message).not.toContain("sk-secret-value");
});

// Usefulness: verifies a provider error object whose fields are not strings or a number yields the
// fixed no-detail line rather than a coerced "[object Object]" detail or a throw that would replace
// the exit code, so a malformed provider payload cannot lose the exit code (issue #326).
test("opencode reports no detail for a malformed provider object", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: errorEvent({
      type: { name: "provider.internal" },
      message: { detail: "Internal server error" },
      status: { code: 500 },
    }),
  });

  expect(error.message).toBe(NO_DETAIL);
  expect(error.message).not.toContain("object Object");
});

// Usefulness: verifies no debug line carries stream or stderr content, because `logDebug` writes to
// stdout in the loop CLI, where a caller can persist it, and because a CLI can print a secret on
// either stream. The exit code and the byte counts stay, so an operator still sees the shape of the
// failure (issue #326).
test("opencode logs byte counts instead of stream or stderr content", async () => {
  vi.mocked(logDebug).mockClear();

  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: `token sk-stream-secret in the event stream ${"S".repeat(500)}`,
    stderr: "api key sk-stderr-secret rejected",
  });

  const logged = vi
    .mocked(logDebug)
    .mock.calls.map(([line]) => line)
    .join("\n");

  expect(logged).not.toContain("sk-stream-secret");
  expect(logged).not.toContain("sk-stderr-secret");
  expect(logged).toContain("opencode exited with code 1");
  expect(logged).toContain(`${Buffer.byteLength(error.stdout)} stdout bytes`);
  expect(logged).toContain(`${Buffer.byteLength(error.stderr)} stderr bytes`);
  expect(error.stdout).toContain("sk-stream-secret");
});

// Usefulness: verifies a signal-killed turn names the signal rather than a provider error event from
// the partial stream, because the signal is why the turn died (issue #326).
test("opencode reports a signal instead of a partial-stream error event", async () => {
  const error = await rejectTurnWith({
    exitCode: undefined,
    stdout: errorEvent({ type: "provider.invalid-output", message: "stream ended early" }),
    isTerminated: true,
    signal: "SIGTERM",
  });

  expect(error.message).toBe("opencode was killed by SIGTERM.");
  expect(error.message).not.toContain("stream ended early");
});

// Usefulness: verifies a timed-out turn names the timeout, so a slow provider cannot be misreported
// as a provider error from the stream it left behind (issue #326).
test("opencode reports a timeout instead of a partial-stream error event", async () => {
  const error = await rejectTurnWith(
    {
      exitCode: undefined,
      stdout: errorEvent({ type: "provider.invalid-output", message: "stream ended early" }),
      timedOut: true,
    },
    { timeout: 900 },
  );

  expect(error.message).toBe("opencode timed out after 900 seconds.");
  expect(error.message).not.toContain("stream ended early");
});

// Usefulness: verifies an error whose timedOut getter throws still reports the cause it carries, so a
// hostile error never replaces the original failure on the adapter error path.
test("opencode reports the original cause when a timedOut getter throws", async () => {
  const failure = Object.assign(new Error("opencode was canceled."), {
    stdout: "",
    stderr: "",
    isCanceled: true,
  });
  Object.defineProperty(failure, "timedOut", {
    get() {
      throw new Error("timedOut getter threw");
    },
  });
  vi.mocked(exec).mockRejectedValueOnce(failure);

  const error = await runOpenCode(
    { kind: "opencode", sessionId: null, model: null, effort: null },
    "oc prompt",
    { cwd: "/dir" },
  ).catch((err) => err);

  expect(error).toBe(failure);
  expect(error.message).toBe("opencode was canceled.");
});

// Usefulness: verifies a buffer overflow keeps its cause through the adapter, not an exit-code
// message that hides why the stream was cut (issue #578).
test("opencode reports a buffer overflow instead of an exit-code message", async () => {
  const error = await rejectTurnWith({
    exitCode: 0,
    stdout: "",
    isMaxBuffer: true,
  });

  expect(error.message).toBe("opencode output exceeded the buffer limit and was cut.");
});

// Usefulness: verifies a turn whose CLI never started names the spawn failure rather than reading an
// error event out of the empty output (issue #326).
test("opencode reports a spawn failure with no exit code", async () => {
  const error = await rejectTurnWith({ exitCode: undefined, stdout: "" });

  expect(error.message).toBe("opencode failed to start.");
});

// Usefulness: verifies the exit code survives a stream holding a `null` line and other non-object
// lines, so the message names the exit code whatever the stream contains (issue #326).
test("opencode reports the exit code when the stream holds a null event", async () => {
  const error = await rejectTurnWith({
    exitCode: 3,
    stdout: ["null", "42", '"a string"', errorEvent({ type: "provider.rate-limit" })].join("\n"),
  });

  expect(error.message).toBe("opencode exited with code 3: provider.rate-limit");
});

// Usefulness: verifies a stream with several error events names the last one, so a retried turn
// reports its most recent failure rather than the first (issue #326).
test("opencode reports the last error event when the stream holds several", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: [
      errorEvent({ type: "provider.rate-limit", message: "slow down" }),
      textEvent("retrying"),
      errorEvent({ type: "provider.invalid-output", message: "stream ended early", status: 200 }),
    ].join("\n"),
  });

  expect(error.message).toBe(
    "opencode exited with code 1: provider.invalid-output: stream ended early (status 200)",
  );
});

// Usefulness: verifies a trailing malformed error event does not mask an earlier well-formed one,
// so an unexpected trailing shape still leaves the reported cause readable (issue #326).
test("opencode reports the last well-formed error event", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: [
      errorEvent({ type: "provider.internal", message: "Internal server error", status: 500 }),
      errorEvent(`unreadable payload ${"R".repeat(5000)}`),
    ].join("\n"),
  });

  expect(error.message).toBe(
    "opencode exited with code 1: provider.internal: Internal server error (status 500)",
  );
  expect(error.message).not.toContain("R".repeat(40));
});

// Usefulness: verifies a live 401 event with `response.body` leaks no body, which no other fixture covers.
test("opencode omits the provider response body from an authentication failure", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: errorEvent({
      type: "provider.auth",
      message: "invalid x-api-key",
      status: 401,
      response: { body: '{"request_id":"BODYSENTINEL"}' },
    }),
  });

  expect(error.message).toBe(
    "opencode exited with code 1: provider.auth: invalid x-api-key (status 401)",
  );
  expect(error.message).not.toContain("BODYSENTINEL");
});

// Usefulness: verifies an error event whose payload is not the documented object yields the fixed
// bounded message rather than a crash or the raw event, so an unexpected CLI shape cannot break the
// turn (issue #326).
test("opencode bounds the message for a malformed error event", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: errorEvent(`unreadable payload ${"M".repeat(5000)}`),
  });

  expect(error.message).toBe(NO_DETAIL);
  expect(error.message).not.toContain("M".repeat(40));
});

// Usefulness: verifies a well-formed error event with an oversized message is truncated at the fixed
// 500-character detail cap, so a long provider message cannot fill the envelope or the state file
// the way the raw stream did (#326).
test("opencode caps the described detail at 500 characters", async () => {
  const error = await rejectTurnWith({
    exitCode: 1,
    stdout: errorEvent({ type: "provider.internal", message: `D${"D".repeat(5000)}` }),
  });

  const prefix = "provider.internal: ";
  expect(error.message).toBe(
    `opencode exited with code 1: ${prefix}${"D".repeat(500 - prefix.length)}...`,
  );
  expect(error.message.length).toBeLessThan(600);
});

// Usefulness: verifies a line that parses to a non-object value, such as the `null` of a diagnostic
// line, is skipped on the exit-0 path, so reading the event shape cannot throw a TypeError that
// replaces the adapter error the turn already produced (issue #335).
test("opencode reads an exit-0 stream that holds non-object lines", async () => {
  const stdout = ["null", "42", '"a string"', textEvent("final reply")].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const response = await runOpenCode(state, "oc prompt", { cwd: "/dir" });

  expect(response).toBe("final reply");
  expect(state.sessionId).toBe("sess-oc");
});

// Usefulness: verifies an exit-0 error event detail is capped at the same 500 characters the
// non-zero path applies, so a long provider message cannot reach the dispatch envelope or the state
// file the way the raw event did (issue #335).
test("opencode caps the described detail of an exit-0 error event at 500 characters", async () => {
  const stdout = errorEvent({ type: "provider.internal", message: `D${"D".repeat(5000)}` });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir" }).catch((err) => err);

  const prefix = "provider.internal: ";
  expect(error.message).toBe(
    `opencode returned an error event: ${prefix}${"D".repeat(500 - prefix.length)}...`,
  );
  expect(error.message.length).toBeLessThan(600);
});

// Usefulness: verifies an exit-0 stream holding several error events names the last one, the rule
// the non-zero path uses, so a turn that retried reports its most recent failure rather than the
// first (issue #335).
test("opencode reports the last error event on an exit-0 turn", async () => {
  const stdout = [
    errorEvent({ type: "provider.rate-limit", message: "slow down" }),
    errorEvent({ type: "provider.invalid-output", message: "stream ended early", status: 200 }),
  ].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir" }).catch((err) => err);

  expect(error.message).toBe(
    "opencode returned an error event: provider.invalid-output: stream ended early (status 200)",
  );
});

// Usefulness: verifies an exit-0 error event whose payload fields are not strings reports the fixed
// `unknown error` detail, not a coerced "[object Object]: [object Object]" that the raw describeError
// on this path produces, so a malformed provider payload cannot put an unreadable detail in the
// envelope (issue #335). The object form is the case that discriminates: a non-object payload
// already described as `unknown error` before the change.
test("opencode reports no detail for a malformed exit-0 provider object", async () => {
  const stdout = errorEvent({
    type: { name: "provider.internal" },
    message: { detail: "Internal server error" },
    status: { code: 500 },
  });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir" }).catch((err) => err);

  expect(error.message).toBe("opencode returned an error event: unknown error");
  expect(error.message).not.toContain("object Object");
});

// A stream cannot carry NaN: JSON.parse rejects the literal, so the stream-reachable non-finite
// number is an overflow to Infinity. Every entry is the raw JSON of one malformed usage value, and
// `output` and `cost` stay valid so a dropped value is not confused with a whole-part loss.
const MALFORMED_NUMBERS = ['"1200"', '{"count":1200}', "null", "-1200", "1e999", "true"];

// Usefulness: verifies a malformed token value is dropped instead of summed or stringified into the
// recorded usage, and that the exit-code message still reaches the envelope, because the usage is
// read before the message is built (issue #326).
test.each(MALFORMED_NUMBERS)(
  "opencode drops the token value %s on a non-zero exit",
  async (raw) => {
    const state = { kind: "opencode", sessionId: null, model: null, effort: null };
    const stdout = `{"type":"step_finish","sessionID":"sess-oc","part":{"tokens":{"input":${raw},"output":3},"cost":0.01}}`;

    const error = await rejectTurnWith({ exitCode: 1, stdout }, {}, state);

    expect(error.message).toBe(NO_DETAIL);
    expect(state.usage).toEqual({
      mainLoop: { input: 0, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      totalCostUsd: 0.01,
    });
  },
);

// Usefulness: verifies a malformed cost leaves `totalCostUsd` unset rather than recording a string, a
// negative, or an infinite total, so the usage a transcript reads stays a number the caller can sum
// (issue #326).
test.each(MALFORMED_NUMBERS)("opencode drops the cost value %s on a non-zero exit", async (raw) => {
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const stdout = `{"type":"step_finish","sessionID":"sess-oc","part":{"tokens":{"input":5},"cost":${raw}}}`;

  const error = await rejectTurnWith({ exitCode: 1, stdout }, {}, state);

  expect(error.message).toBe(NO_DETAIL);
  expect(state.usage).toEqual({
    mainLoop: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  expect(state.usage.totalCostUsd).toBeUndefined();
});

// Usefulness: verifies a total that overflows to Infinity is dropped rather than recorded, because
// two large finite values are the only way a validated sum can stop being a count, and the
// invocation event reads the recorded usage as a number a caller can sum (issue #326). The two step
// parts prove the overflow needs a sum, and the cost proves the second total is checked.
test("opencode drops a usage total that overflows on a non-zero exit", async () => {
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const stdout = [
    `{"type":"step_finish","sessionID":"sess-oc","part":{"tokens":{"input":1e308},"cost":1e308}}`,
    `{"type":"step_finish","sessionID":"sess-oc","part":{"tokens":{"input":1e308},"cost":1e308}}`,
  ].join("\n");

  const error = await rejectTurnWith({ exitCode: 1, stdout }, {}, state);

  expect(error.message).toBe(NO_DETAIL);
  expect(state.usage).toEqual({
    mainLoop: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  expect(state.usage.totalCostUsd).toBeUndefined();
});

// The provider error that opencode v0.0.0-dev-466 streamed for a 529 from a local probe server
// (issue #1017). opencode maps a provider internal error with HTTP 503 or 529 to its overload
// reason, and the stream carries the structured `status`. No live provider reply confirmed it.
const CAPACITY_ERROR = {
  type: "provider.internal",
  message: "Overloaded",
  status: 529,
  response: {
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  },
};

const CAPACITY_TEXT = "Overloaded";

const failedTurn = (stdout, overrides) =>
  Object.assign(new Error("opencode exited with code 1."), {
    exitCode: 1,
    stdout,
    stderr: "",
    ...overrides,
  });

const ocState = () => ({ kind: "opencode", sessionId: null, model: null, effort: null });

// Usefulness: verifies requirement "each adapter with a sourced capacity signal is marked transient" (issue #1017), so a parent retries without reading the error text.
test("opencode marks a provider capacity failure transient", async () => {
  vi.mocked(exec).mockRejectedValueOnce(failedTurn(errorEvent(CAPACITY_ERROR)));

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies the sourced 503 branch of the opencode overload reason (issue #1017): a provider internal error with 503 marks the turn.
test("opencode marks a provider 503 failure transient", async () => {
  vi.mocked(exec).mockRejectedValueOnce(failedTurn(errorEvent({ ...CAPACITY_ERROR, status: 503 })));

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies requirement "consecutive capacity failures stay marked" (issue #1017): the last error event decides, so two capacity events still mark the turn.
test("opencode keeps the mark when consecutive error events are capacity", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    failedTurn([errorEvent(CAPACITY_ERROR), errorEvent(CAPACITY_ERROR)].join("\n")),
  );

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies requirement "a non-capacity failure is never marked" (issue #1017), because a wrong mark makes a parent retry a real fault.
test.each([
  ["another internal status", errorEvent({ ...CAPACITY_ERROR, status: 500 }), {}],
  [
    "a rate limit",
    errorEvent({ type: "provider.rate-limit", message: CAPACITY_TEXT, status: 429 }),
    {},
  ],
  [
    "an auth failure",
    errorEvent({ type: "provider.auth", message: CAPACITY_TEXT, status: 401 }),
    {},
  ],
  ["the wording in response text", textEvent(`the provider said ${CAPACITY_TEXT}`), {}],
  ["a timeout", errorEvent(CAPACITY_ERROR), { timedOut: true }],
  ["a cancel", errorEvent(CAPACITY_ERROR), { isCanceled: true }],
  ["a signal", errorEvent(CAPACITY_ERROR), { isTerminated: true }],
  ["no events", "", {}],
])("opencode does not mark %s transient", async (_name, stdout, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(failedTurn(stdout, overrides));

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies requirement "only the terminal failure decides" (issue #1017): a later error must not make a parent retry a real fault.
test("opencode does not mark a capacity error that a later error replaces", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    failedTurn(
      [
        errorEvent(CAPACITY_ERROR),
        errorEvent({ type: "provider.internal", message: "Internal server error", status: 500 }),
      ].join("\n"),
    ),
  );

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies requirement "a malformed or truncated final line keeps an earlier decisive event" (issue #1017), so a broken tail cannot hide an overload.
test("opencode keeps the mark when the final line is truncated", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    failedTurn(`${errorEvent(CAPACITY_ERROR)}\n{"type":"error","error":{"type":"provider`),
  );

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies the exit-0 error-event path marks the same capacity failure (issue #1017), so the parent gets the field on both paths.
test("opencode marks a capacity error event on an exit-0 turn", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: errorEvent(CAPACITY_ERROR), stderr: "" });

  const caught = await runOpenCode(ocState(), "oc prompt", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
});
