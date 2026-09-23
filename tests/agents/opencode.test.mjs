import { expect, test, vi } from "vitest";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logInfo } from "../../src/lib/log.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

vi.mock("../../src/lib/log.mjs", () => ({
  logInfo: vi.fn(),
}));

const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

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

// Usefulness: verifies a read-only turn maps to the plan agent and denies the subagent action through OPENCODE_CONFIG_CONTENT, so no session-model subagent can launch (issue #90).
test("opencode sends an explicit model#effort and --agent plan when readOnly is true", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("opencode reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: "claude-3-5", effort: "high" };
  const response = await runOpenCode(state, "oc prompt", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("opencode reply");
  expect(state.sessionId).toBe("sess-oc");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--agent", "plan", "--model", "claude-3-5#high"],
    {
      cwd: "/dir",
      input: "oc prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: {
        OPENCODE_CONFIG_CONTENT:
          '{"permissions":[{"action":"subagent","resource":"*","effect":"deny"}]}',
      },
    },
  );
  expect(state.model).toBe("claude-3-5");
  expect(state.effort).toBe("high");
});

// Usefulness: verifies a turn with neither model nor effort uses the pinned default at high effort,
// and logs the effective model so the run log records what actually ran.
test("opencode with no model or effort uses the pinned default and logs it", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("defaulted reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: "sess-oc", model: null, effort: null };
  const response = await runOpenCode(state, "defaulted prompt", { cwd: "/dir", readOnly: false });

  expect(response).toBe("defaulted reply");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    [
      "run",
      "--standalone",
      "--format",
      "json",
      "--session",
      "sess-oc",
      "--model",
      `${DEFAULT_MODEL}#high`,
    ],
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
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining(`${DEFAULT_MODEL}#high`));
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
});

// Usefulness: verifies effort without a model reaches the CLI as the default model plus that variant.
test("opencode with effort only uses the default model with that effort", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: textEvent("effort reply"), stderr: "" });

  const state = { kind: "opencode", sessionId: null, model: null, effort: "low" };
  const response = await runOpenCode(state, "effort prompt", { cwd: "/dir" });

  expect(response).toBe("effort reply");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--model", `${DEFAULT_MODEL}#low`],
    { cwd: "/dir", input: "effort prompt", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies a failed defaulted turn names the default model, points at the role override flag,
// keeps the provider detail, and rethrows the same error instance with its operational fields intact.
test("opencode names the default model and override flag on a defaulted turn failure", async () => {
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
    },
  );
  vi.mocked(exec).mockRejectedValueOnce(failure);

  const state = { kind: "opencode", sessionId: null, model: null, effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir", role: "worker" }).catch(
    (err) => err,
  );

  expect(error).toBe(failure);
  expect(error.message).toContain(DEFAULT_MODEL);
  expect(error.message).toContain("--worker-model");
  expect(error.message).toContain("provider.internal: Internal server error (status 500)");
  expect(error.name).toBe("ExecError");
  expect(error.timedOut).toBe(true);
  expect(error.isCanceled).toBe(true);
  expect(error.isTerminated).toBe(true);
  expect(error.command).toBe("opencode");
  expect(error.exitCode).toBe(1);
});

// Usefulness: verifies an explicit-model failure is not blamed on the default, so guidance stays accurate.
test("opencode does not mention the default on an explicit-model failure", async () => {
  const { ExecError } = await vi.importActual("../../src/lib/exec.mjs");
  const failure = new ExecError("opencode exited with code 1.", {
    command: "opencode",
    exitCode: 1,
  });
  vi.mocked(exec).mockRejectedValueOnce(failure);

  const state = { kind: "opencode", sessionId: null, model: "claude-3-5", effort: null };
  const error = await runOpenCode(state, "oc prompt", { cwd: "/dir", role: "worker" }).catch(
    (err) => err,
  );

  expect(error.message).not.toContain(DEFAULT_MODEL);
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
    Object.assign(new Error("opencode exited with code 1."), { stdout, stderr: "" }),
  );

  const state = {
    kind: "opencode",
    sessionId: null,
    model: null,
    effort: null,
    usage: { stale: 1 },
  };
  await expect(runOpenCode(state, "oc prompt", { cwd: "/dir" })).rejects.toThrow(
    "opencode exited with code 1.",
  );
  expect(state.usage).toEqual({
    mainLoop: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    totalCostUsd: 0.001,
  });
});
