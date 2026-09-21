import { expect, test, vi } from "vitest";
import { runCopilot } from "../../src/agents/copilot.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

// Usefulness: verifies Copilot requests JSON output and reads the assistant message from the stream.
test("copilot sends --output-format json and returns assistant text", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"assistant.message","data":{"content":"copilot response"}}',
      '{"type":"result","sessionId":"copilot-sess-1","exitCode":0}',
    ].join("\n"),
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
      "--output-format",
      "json",
      "--deny-tool",
      "write",
      "--model",
      "claude-3-7-sonnet",
      "--reasoning-effort",
      "high",
    ],
    {
      cwd: "/dir",
      input: "copilot prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
});

// Usefulness: verifies Copilot reads the assistant message from the JSONL stream instead of raw stdout.
test("copilot reads response text from JSONL events", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"session.mcp_server_status_changed","data":{"serverName":"github","status":"connected"}}',
      '{"type":"assistant.message","data":{"content":"Hello from Copilot"}}',
      '{"type":"result","sessionId":"copilot-sess-1","exitCode":0,"usage":{"premiumRequests":1}}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "copilot-sess-1", model: null, effort: null };
  const response = await runCopilot(state, "copilot prompt 3", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("Hello from Copilot");
  expect(state.usage).toEqual({ mainLoop: { premiumRequests: 1 } });
  expect(exec).toHaveBeenCalledWith(
    "copilot",
    ["--session-id", "copilot-sess-1", "-s", "--no-ask-user", "--output-format", "json"],
    {
      cwd: "/dir",
      input: "copilot prompt 3",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
});

// Usefulness: verifies the adapter keeps the empty-stream failure when JSONL output contains no text event.
test("copilot throws when the JSONL stream is empty", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: "",
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "copilot-sess-1", model: null, effort: null };
  await expect(
    runCopilot(state, "copilot prompt 4", {
      cwd: "/dir",
      readOnly: false,
    }),
  ).rejects.toThrow("Copilot did not return response text.");
});

// Usefulness: verifies a JSONL result without usage data leaves no stale usage behind.
test("copilot leaves usage unset when the stream reports no usage", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"assistant.message","data":{"content":"No usage here"}}',
      '{"type":"result","sessionId":"copilot-sess-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = {
    kind: "copilot",
    sessionId: "copilot-sess-1",
    model: null,
    effort: null,
    usage: { stale: 1 },
  };

  const response = await runCopilot(state, "copilot prompt 5", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("No usage here");
  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies Copilot initializes a new session when none exists and accepts the returned session id.
test("copilot initializes session and runs with readOnly false", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"assistant.message","data":{"content":"copilot response 2"}}',
      '{"type":"result","sessionId":"copilot-sess-2","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: null, model: null, effort: null };
  const response = await runCopilot(state, "copilot prompt 2", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("copilot response 2");
  expect(state.sessionId).toBe("copilot-sess-2");
  expect(exec).toHaveBeenCalledWith(
    "copilot",
    ["--session-id", expect.any(String), "-s", "--no-ask-user", "--output-format", "json"],
    {
      cwd: "/dir",
      input: "copilot prompt 2",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
});
