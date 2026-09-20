import { expect, test, vi } from "vitest";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies opencode adapter runs standalone by default, adds --agent plan when readOnly is true, and handles model#effort.
test("opencode sends --standalone and --agent plan when readOnly is true", async () => {
  const stdout = JSON.stringify({
    type: "text",
    sessionID: "sess-oc",
    part: { text: "opencode reply" },
  });
  vi.mocked(exec).mockResolvedValueOnce({
    stdout,
    stderr: "",
  });

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
});

// Usefulness: verifies opencode keeps --standalone and resumes a session without --agent plan when readOnly is false.
test("opencode resumes session with --standalone", async () => {
  const stdout = JSON.stringify({
    type: "text",
    sessionID: "sess-oc",
    part: { text: "resumed oc" },
  });
  vi.mocked(exec).mockResolvedValueOnce({
    stdout,
    stderr: "",
  });

  const state = { kind: "opencode", sessionId: "sess-oc", model: null, effort: null };
  const response = await runOpenCode(state, "resume oc", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("resumed oc");
  expect(exec).toHaveBeenCalledWith(
    "opencode",
    ["run", "--standalone", "--format", "json", "--session", "sess-oc"],
    { cwd: "/dir", input: "resume oc", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies a failed opencode turn names the provider error event instead of the
// generic missing-text error, which is what left the cause of issue #74 unknown.
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
