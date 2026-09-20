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

// Usefulness: verifies an explicit model with effort passes through as model#effort, and readOnly maps to --agent plan.
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
    { cwd: "/dir", input: "oc prompt", timeout: undefined, signal: undefined, role: undefined },
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

// Usefulness: verifies an explicit model without effort passes as given, with no appended default variant.
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
