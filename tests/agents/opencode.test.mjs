import { expect, test, vi } from "vitest";
import { runOpenCode } from "../../src/agents/opencode.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies opencode adapter adds --agent plan when readOnly is true and handles model#effort.
test("opencode sends --agent plan when readOnly is true", async () => {
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
    ["run", "--format", "json", "--agent", "plan", "--model", "claude-3-5#high"],
    { cwd: "/dir", input: "oc prompt", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies opencode resumes session without --agent plan when readOnly is false.
test("opencode resumes session", async () => {
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
    ["run", "--format", "json", "--session", "sess-oc"],
    { cwd: "/dir", input: "resume oc", timeout: undefined, signal: undefined, role: undefined },
  );
});
