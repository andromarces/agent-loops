import { expect, test, vi } from "vitest";
import { runCopilot } from "../../src/agents/copilot.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { runChild } from "../../src/runtime.mjs";

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

// Usefulness: verifies a resumed Copilot session cannot silently switch to a different session.
test("copilot rejects a changed session id", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"assistant.message","data":{"content":"Wrong session"}}',
      '{"type":"result","sessionId":"copilot-sess-2","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "copilot-sess-1", model: null, effort: null };
  await expect(
    runCopilot(state, "copilot prompt with wrong session", {
      cwd: "/dir",
      readOnly: false,
    }),
  ).rejects.toThrow(
    "Copilot did not resume the expected session.\nExpected: copilot-sess-1\nReceived: copilot-sess-2",
  );
});

// Usefulness: verifies usage from a failed Copilot JSONL result reaches the caller before the error is rethrown.
test("copilot maps usage from a failed JSONL result", async () => {
  const error = new Error("Copilot failed");
  error.stdout = [
    '{"type":"assistant.message","data":{"content":"Partial response"}}',
    '{"type":"result","sessionId":"copilot-sess-1","exitCode":1,"usage":{"premiumRequests":2}}',
  ].join("\n");
  vi.mocked(exec).mockRejectedValueOnce(error);

  const state = {
    kind: "copilot",
    sessionId: "copilot-sess-1",
    model: null,
    effort: null,
    usage: { stale: 1 },
  };

  await expect(
    runCopilot(state, "copilot failed prompt", {
      cwd: "/dir",
      readOnly: false,
    }),
  ).rejects.toBe(error);
  expect(state.usage).toEqual({ mainLoop: { premiumRequests: 2 } });
});

// Usefulness: verifies the adapter keeps the empty-stream failure when JSONL output contains no text event.
test("copilot throws when the JSONL stream is empty", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: '{"type":"result","sessionId":"copilot-sess-1","exitCode":0}',
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

// Usefulness: verifies a successful stream without a result session id fails instead of preserving an unverified session.
test("copilot throws when the JSONL stream has no result session id", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: '{"type":"assistant.message","data":{"content":"Response without session"}}',
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "copilot-sess-1", model: null, effort: null };
  await expect(
    runCopilot(state, "copilot prompt without result", {
      cwd: "/dir",
      readOnly: false,
    }),
  ).rejects.toThrow("Copilot did not return a session ID.");
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
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => ({
    stdout: [
      '{"type":"assistant.message","data":{"content":"copilot response 2"}}',
      `{"type":"result","sessionId":${JSON.stringify(String(args[1]))},"exitCode":0}`,
    ].join("\n"),
    stderr: "",
  }));

  const state = { kind: "copilot", sessionId: null, model: null, effort: null };
  const response = await runCopilot(state, "copilot prompt 2", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("copilot response 2");
  const requestedSessionId = vi.mocked(exec).mock.calls[0][1][1];
  expect(requestedSessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(state.sessionId).toBe(requestedSessionId);
  expect(exec).toHaveBeenCalledWith(
    "copilot",
    ["--session-id", requestedSessionId, "-s", "--no-ask-user", "--output-format", "json"],
    {
      cwd: "/dir",
      input: "copilot prompt 2",
      timeout: undefined,
      signal: undefined,
      role: undefined,
    },
  );
});

// Usefulness: verifies a failed first Copilot worker turn leaves no session id, so the next worker turn still carries the preamble.
test("a failed first copilot worker turn leaves sessionId null and the next turn carries the preamble", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec)
    .mockRejectedValueOnce(new Error("copilot auth failure"))
    .mockImplementationOnce(async (_command, args) => ({
      stdout: [
        '{"type":"assistant.message","data":{"content":"done"}}',
        `{"type":"result","sessionId":${JSON.stringify(String(args[1]))},"exitCode":0}`,
      ].join("\n"),
      stderr: "",
    }));

  const role = { kind: "copilot", sessionId: null, model: null, effort: null };
  const first = await runChild({ role, roleName: "worker", prompt: "do the task", cwd: "/dir" });

  expect(first.status).toBe("error");
  expect(role.sessionId).toBeNull();
  expect(vi.mocked(exec).mock.calls[0][2].input).toContain(
    "You are the implementation agent (worker)",
  );

  const second = await runChild({
    role,
    roleName: "worker",
    prompt: "retry the task",
    cwd: "/dir",
  });

  expect(second.status).toBe("ok");
  expect(vi.mocked(exec).mock.calls[1][2].input).toContain(
    "You are the implementation agent (worker)",
  );
  expect(role.sessionId).toBe(vi.mocked(exec).mock.calls[1][1][1]);
});

// Usefulness: verifies a first turn stores the id Copilot reports when it differs from the pre-assigned one, so the next turn resumes the real session.
test("copilot stores the reported id when it differs from the pre-assigned id on a first turn", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      '{"type":"assistant.message","data":{"content":"Other session"}}',
      '{"type":"result","sessionId":"copilot-other-sess","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: null, model: null, effort: null };
  const response = await runCopilot(state, "copilot first turn prompt", {
    cwd: "/dir",
    readOnly: false,
  });

  expect(response).toBe("Other session");
  expect(state.sessionId).toBe("copilot-other-sess");
});

// Usefulness: verifies a first turn that reports an id and then fails response validation leaves sessionId null, so the next worker turn keeps its preamble.
test("a first copilot worker turn that reports an id then fails leaves sessionId null and the next turn carries the preamble", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec)
    .mockResolvedValueOnce({
      stdout: '{"type":"result","sessionId":"copilot-reported-sess","exitCode":0}',
      stderr: "",
    })
    .mockResolvedValueOnce({
      stdout: [
        '{"type":"assistant.message","data":{"content":"done"}}',
        '{"type":"result","sessionId":"copilot-reported-sess-2","exitCode":0}',
      ].join("\n"),
      stderr: "",
    });

  const role = { kind: "copilot", sessionId: null, model: null, effort: null };
  const first = await runChild({ role, roleName: "worker", prompt: "do the task", cwd: "/dir" });

  expect(first.status).toBe("error");
  expect(first.error).toContain("Copilot did not return response text.");
  expect(role.sessionId).toBeNull();

  const second = await runChild({
    role,
    roleName: "worker",
    prompt: "retry the task",
    cwd: "/dir",
  });

  expect(second.status).toBe("ok");
  expect(vi.mocked(exec).mock.calls[1][2].input).toContain(
    "You are the implementation agent (worker)",
  );
});
