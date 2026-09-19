import { expect, test, vi } from "vitest";
import { runCopilot } from "../../src/agents/copilot.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies copilot adapter adds --deny-tool write when readOnly is true.
test("copilot sends --deny-tool write when readOnly is true", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: "copilot response",
    stderr: "",
  });

  const state = {
    kind: "copilot",
    sessionId: "copilot-sess-1",
    model: "claude-3-7-sonnet",
    effort: "high",
  };
  const response = await runCopilot(state, "copilot prompt", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("copilot response");
  expect(exec).toHaveBeenCalledWith(
    "copilot",
    [
      "--session-id",
      "copilot-sess-1",
      "-s",
      "--no-ask-user",
      "--deny-tool",
      "write",
      "--model",
      "claude-3-7-sonnet",
      "--reasoning-effort",
      "high",
    ],
    { cwd: "/dir", input: "copilot prompt", timeout: undefined, signal: undefined },
  );
});

// Usefulness: verifies copilot initializes session id if not provided and runs without --deny-tool write when readOnly is false.
test("copilot initializes session and runs with readOnly false", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: "copilot response 2",
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: null, model: null, effort: null };
  const response = await runCopilot(state, "copilot prompt 2", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("copilot response 2");
  expect(state.sessionId).toBeTruthy();
  expect(exec).toHaveBeenCalledWith(
    "copilot",
    ["--session-id", state.sessionId, "-s", "--no-ask-user"],
    { cwd: "/dir", input: "copilot prompt 2", timeout: undefined, signal: undefined },
  );
});
