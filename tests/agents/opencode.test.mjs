import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logDebug, logInfo } from "../../src/lib/log.mjs";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role.mjs";
import { createTempRepo, removePath, restoreRunsRoot } from "../runtime-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
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
let dispatchPaths = [];

afterEach(async () => {
  restoreRunsRoot();
  const paths = dispatchPaths;
  dispatchPaths = [];
  // Every registered path is attempted so one failure cannot strand the rest, and the first
  // failure is rethrown so a real cleanup failure still fails the run.
  let firstError;
  for (const path of paths) {
    if (typeof path !== "string") {
      continue;
    }
    try {
      await removePath(path);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw firstError;
  }
});

function textEvent(text) {
  return JSON.stringify({
    type: "text",
    sessionID: "sess-oc",
    part: { text },
  });
}

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

// Usefulness: verifies an explicit model with effort reaches the CLI as model#effort on a worker turn.
test("opencode sends an explicit model#effort", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("opencode reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: "claude-3-5", effort: "high" };
  const response = await runOpenCode(state, "oc prompt", { cwd: "/dir" });

  expect(response).toBe("opencode reply");
  expect(state.sessionId).toBe("sess-oc");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--model", "claude-3-5#high"],
    {
      cwd: "/dir",
      input: "oc prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
  expect(state.model).toBe("claude-3-5");
  expect(state.effort).toBe("high");
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("claude-3-5#high"));
});

/** Returns the permission rules from the read-only per-turn config on the last opencode call. */
function readOnlyPermissions() {
  const call = vi.mocked(exec).mock.calls.at(-1);
  return JSON.parse(call[2].env.OPENCODE_CONFIG_CONTENT).permissions;
}

// Usefulness: verifies a read-only turn maps to --agent plan, so the plan agent supplies the base
// read-only guard (issue #90).
test("opencode maps a read-only turn to the plan agent", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("opencode reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const response = await runOpenCode(state, "oc prompt", { cwd: "/dir", readOnly: true });

  expect(response).toBe("opencode reply");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--agent", "plan"],
    {
      cwd: "/dir",
      input: "oc prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: expect.any(Object),
    },
  );
});

// Usefulness: verifies the read-only turn denies the subagent action through OPENCODE_CONFIG_CONTENT,
// so the plan agent cannot launch session-model subagents (issue #90).
test("opencode denies the subagent action on a read-only turn", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("opencode reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await runOpenCode(state, "oc prompt", { cwd: "/dir", readOnly: true });

  expect(readOnlyPermissions()).toContainEqual({
    action: "subagent",
    resource: "*",
    effect: "deny",
  });
});

// Usefulness: verifies the read-only turn denies the edit action through OPENCODE_CONFIG_CONTENT, so
// a global permissions allow that resolves after the plan agent's edit deny cannot restore the edit
// and write tools (issue #107).
test("opencode denies the edit action on a read-only turn", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("opencode reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await runOpenCode(state, "oc prompt", { cwd: "/dir", readOnly: true });

  expect(readOnlyPermissions()).toContainEqual({
    action: "edit",
    resource: "*",
    effect: "deny",
  });
});

// Usefulness: verifies a turn with neither model nor effort passes no --model, so OpenCode
// selects its own default, and the log says so without naming a model.
test("opencode with no model or effort passes no --model and logs the CLI default", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("defaulted reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: "sess-oc", model: null, effort: null };
  const response = await runOpenCode(state, "defaulted prompt", { cwd: "/dir", readOnly: false });

  expect(response).toBe("defaulted reply");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--session", "sess-oc"],
    {
      cwd: "/dir",
      input: "defaulted prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
  expect(state.model).toBeNull();
  expect(state.effort).toBeNull();
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("OpenCode selects its CLI default"));
  expect(logInfo).not.toHaveBeenCalledWith(expect.stringContaining("effective model"));
});

// Usefulness: verifies a worker turn (readOnly false) passes an explicit model without effort as given,
// with no appended default variant and no subagent-denying environment, so the read-only switch does not
// reach worker turns (issue #90).
test("opencode with a model and no effort passes the model unchanged", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("explicit reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: "claude-3-5", effort: null };
  const response = await runOpenCode(state, "explicit prompt", { cwd: "/dir" });

  expect(response).toBe("explicit reply");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--model", "claude-3-5"],
    {
      cwd: "/dir",
      input: "explicit prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
  expect(exec.mock.calls[0][2].env).toBeUndefined();
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("claude-3-5"));
});

// Usefulness: verifies effort without a model is rejected instead of silently dropping the effort;
// argument validation rejects it at both entry points, and this guards a direct adapter call. The
// message names the role model flag when the role is known, so a pre-upgrade run learns the flag.
test("opencode rejects an effort without a model and names the model flag", async () => {
  const state = { kind: "opencode", sessionId: null, model: null, effort: "low" };

  await expect(runOpenCode(state, "effort prompt", { cwd: "/dir" })).rejects.toThrow(
    "requires an explicit model",
  );
  await expect(
    runOpenCode(state, "effort prompt", { cwd: "/dir", role: "worker" }),
  ).rejects.toThrow("requires --worker-model");
  expect(exec).not.toHaveBeenCalled();
});

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

function errorEvent(error) {
  return JSON.stringify({ type: "error", sessionID: "sess-oc", error });
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

const CLOSING_BLOCK = [
  "Conclusion: PR #314 fixes the part join.",
  "Why: the narration and the block arrived as two text parts.",
  "Blockers: none",
  "Checks: pnpm test",
  "Notes: none",
  "Deferred: none",
].join("\n");

/** Streams `text` as the response of an opencode turn and returns the response text. */
async function runWithText(...text) {
  const stdout = text.map(textEvent).join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  return runOpenCode(state, "oc prompt", { cwd: "/dir" });
}

// Usefulness: verifies a part that opens a closing-block label starts its own line, so the
// dispatch envelope carries the parsed report instead of falling through to `raw` (issue #316).
// The assertions read the response through the same two functions `dispatchPayload`
// (src/role.mjs) calls, so a caller sees exactly the `report` and `raw` fields asserted here.
// A single part carries the block unchanged, so the same test also covers the no-separator case.
test("opencode keeps a closing-block label at the start of its own line", async () => {
  const single = await runWithText(CLOSING_BLOCK);

  expect(single).toBe(CLOSING_BLOCK);
  expect(parseReportBlock(single)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });

  const split = await runWithText("The narration ends here.", CLOSING_BLOCK);

  expect(split).toBe("The narration ends here.\n" + CLOSING_BLOCK);
  expect(parseReportBlock(split)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies a part that continues a sentence gains no line break, so a mid-sentence
// split keeps the prose intact, the envelope still carries the parsed report, and an unconditional
// newline join cannot pass (issue #316).
test("opencode joins a mid-sentence split without a line break", async () => {
  const response = await runWithText(
    "The fix changes the join so the",
    " block parses.\n" + CLOSING_BLOCK,
  );

  expect(response).toBe("The fix changes the join so the block parses.\n" + CLOSING_BLOCK);
  expect(parseReportBlock(response)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies the caller-visible envelope for a two-event opencode stream, so the join is
// covered where a caller reads it. A narration part then the part that opens the closing block must
// reach the caller as a parsed `report` with no `raw`, which is the field the parent loop reads for
// the structured fields. The join tests above cover the string; this one covers the seam (issue #316).
test("an opencode stream split before the closing block reaches the dispatch envelope", async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), "opencode-test-runs-"));
  dispatchPaths.push(runsRoot);
  const repo = await createTempRepo();
  dispatchPaths.push(repo);
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;

  const init = parseRoleArgs([
    "dispatch",
    "--role",
    "worker",
    "--cwd",
    repo,
    "--task",
    "Fix the part join.",
    "--parent-session",
    "sess-parent-1",
    "--worker",
    "opencode",
    "--reviewer",
    "opencode",
  ]);
  const stdin = async () => "continue working";
  vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
  await executeRoleCommand(init, { agents: { opencode: { run: runOpenCode } }, stdin });

  vi.mocked(exec).mockResolvedValue({
    stdout: [textEvent("The narration ends here."), textEvent(CLOSING_BLOCK)].join("\n"),
    stderr: "",
  });
  const result = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--cwd", repo]),
    { agents: { opencode: { run: runOpenCode } }, stdin },
  );

  expect(result.exitCode).toBe(0);
  expect(result.payload.status).toBe("ok");
  expect(result.payload.report).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
  expect(result.payload.raw).toBeUndefined();
});

// Usefulness: verifies a part boundary inside a sentence does not promote mid-line text to a
// column-0 `Verdict:` label, so the dispatch envelope keeps `verdict: unknown` where the joined
// string holds the word mid-line (issue #316). Lifting it would invent a verdict the model never
// wrote as a label, and a verdict gates acceptance. The report still parses, so the probe covers
// both envelope fields in one turn.
test("opencode keeps a mid-line Verdict part out of the closing block", async () => {
  const response = await runWithText(CLOSING_BLOCK + "\n\nThe reviewer said", "Verdict: accept");

  expect(parseVerdict(response)).toBe("unknown");
  expect(response).toContain("The reviewer saidVerdict: accept");
  expect(parseReportBlock(response)).toEqual({
    conclusion: "PR #314 fixes the part join.",
    why: "the narration and the block arrived as two text parts.",
    blockers: "none",
    checks: "pnpm test",
    notes: "none",
    deferred: "none",
  });
});

// Usefulness: verifies a timed-out first turn keeps the session id its partial stream printed, so
// the next turn resumes it (issue #360). A resumed turn keeps its stored id.
test("opencode keeps the session id from a failed first turn", async () => {
  const stdout = JSON.stringify({ type: "step_start", sessionID: "ses-failed", part: {} });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("opencode timed out."), { stdout, stderr: "", timedOut: true }),
  );
  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await expect(runOpenCode(state, "p", { cwd: "/dir" })).rejects.toThrow("timed out");
  expect(state.sessionId).toBe("ses-failed");

  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("opencode exited."), { stdout, stderr: "", exitCode: 1 }),
  );
  const resumed = { kind: "opencode", sessionId: "ses-stored", model: null, effort: null };
  await expect(runOpenCode(resumed, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(resumed.sessionId).toBe("ses-stored");
});

// Usefulness: verifies a first turn that reports a session and then fails response validation keeps
// the session id, as issue #360 requires of every adapter error path.
test("opencode keeps the session id when a first turn fails response validation", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ type: "step_start", sessionID: "ses-validated", part: {} }),
    stderr: "",
  });

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  await expect(runOpenCode(state, "p", { cwd: "/dir" })).rejects.toThrow("response text");
  expect(state.sessionId).toBe("ses-validated");
});
