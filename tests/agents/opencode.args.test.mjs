import { expect, test, vi } from "vite-plus/test";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { logInfo } from "../../src/lib/log.mjs";
import { textEvent } from "./opencode-helpers.mjs";

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
