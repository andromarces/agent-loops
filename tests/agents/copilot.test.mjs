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

// Usefulness: verifies a first turn that reports an id and then fails response validation keeps that id, as issue #360 requires of every adapter error path, so the next worker turn resumes the reported session without a second preamble.
test("a first copilot worker turn that reports an id then fails keeps the id and the next turn resumes it", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec)
    .mockResolvedValueOnce({
      stdout: '{"type":"result","sessionId":"copilot-reported-sess","exitCode":0}',
      stderr: "",
    })
    .mockResolvedValueOnce({
      stdout: [
        '{"type":"assistant.message","data":{"content":"done"}}',
        '{"type":"result","sessionId":"copilot-reported-sess","exitCode":0}',
      ].join("\n"),
      stderr: "",
    });

  const role = { kind: "copilot", sessionId: null, model: null, effort: null };
  const first = await runChild({ role, roleName: "worker", prompt: "do the task", cwd: "/dir" });

  expect(first.status).toBe("error");
  expect(first.error).toContain("Copilot did not return response text.");
  expect(role.sessionId).toBe("copilot-reported-sess");

  const second = await runChild({
    role,
    roleName: "worker",
    prompt: "retry the task",
    cwd: "/dir",
  });

  expect(second.status).toBe("ok");
  expect(vi.mocked(exec).mock.calls[1][1][1]).toBe("copilot-reported-sess");
  expect(vi.mocked(exec).mock.calls[1][2].input).not.toContain(
    "You are the implementation agent (worker)",
  );
  expect(role.sessionId).toBe("copilot-reported-sess");
});

// Usefulness: verifies a resumed turn that fails response validation never changes its id.
test("copilot keeps the stored id when a resumed turn fails response validation", async () => {
  vi.mocked(exec).mockReset();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: '{"type":"result","sessionId":"copilot-stored","exitCode":0}',
    stderr: "",
  });
  const state = { kind: "copilot", sessionId: "copilot-stored", model: null, effort: null };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("response text");
  expect(state.sessionId).toBe("copilot-stored");
});

// Usefulness: verifies a failed first turn keeps the session id the CLI reported in its result
// event, so the next turn resumes it, and keeps none when the failed output reports none. The
// pre-assigned id is never kept: a failed turn that reports no id does not show that a session
// exists (issue #360).
test("copilot keeps the reported session id of a failed first turn", async () => {
  const error = new Error("Copilot failed");
  error.stdout = '{"type":"result","sessionId":"copilot-reported","exitCode":1}';
  vi.mocked(exec).mockRejectedValueOnce(error);

  const state = { kind: "copilot", sessionId: null, model: null, effort: null };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toBe(error);
  expect(state.sessionId).toBe("copilot-reported");

  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("Copilot failed"), { stdout: '{"type":"session.tools_updated"}' }),
  );
  const silent = { kind: "copilot", sessionId: null, model: null, effort: null };
  await expect(runCopilot(silent, "p", { cwd: "/dir" })).rejects.toThrow("Copilot failed");
  expect(silent.sessionId).toBeNull();
});

// Usefulness: verifies a failed resumed turn never changes its id, whatever the result reports.
test("copilot keeps the stored session id when a resumed turn fails", async () => {
  const error = new Error("Copilot failed");
  error.stdout = '{"type":"result","sessionId":"copilot-other","exitCode":1}';
  vi.mocked(exec).mockRejectedValueOnce(error);

  const state = { kind: "copilot", sessionId: "copilot-stored", model: null, effort: null };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toBe(error);
  expect(state.sessionId).toBe("copilot-stored");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("copilot rejects %s as the reported session id", async (_name, id) => {
  const stdout = [
    { type: "assistant.message", data: { content: "ok" } },
    { type: "result", sessionId: id, exitCode: 0 },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "copilot", sessionId: null, model: null, effort: null };
  await expect(runCopilot(first, "p", { cwd: "/dir" })).rejects.toThrow(
    "Copilot did not return a session ID.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "copilot", sessionId: "stored", model: null, effort: null };
  await expect(runCopilot(resumed, "p", { cwd: "/dir" })).rejects.toThrow(
    "Copilot did not return a session ID.",
  );
  expect(resumed.sessionId).toBe("stored");
});

// Usefulness: verifies the adapter selects the id from the last result event, then validates
// that selected id, so a later valid id never rescues an invalid or mismatched selected one. A
// resumed turn keeps its stored id on every failure (issue #360).
test.each([
  ["invalid then valid, first turn", [42, "good"], null, "good"],
  ["valid then invalid, first turn", ["good", 42], null, "ERR_ID"],
  ["valid then different valid, first turn", ["a", "b"], null, "b"],
  ["stored then invalid, resumed turn", ["stored", 42], "stored", "ERR_ID"],
  ["stored then different, resumed turn", ["stored", "other"], "stored", "ERR_MISMATCH"],
  ["different then stored, resumed turn", ["other", "stored"], "stored", "stored"],
])("copilot selects then validates the id: %s", async (_name, ids, requested, expected) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      { type: "assistant.message", data: { content: "ok" } },
      ...ids.map((id) => ({ type: "result", sessionId: id, exitCode: 0 })),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    stderr: "",
  });
  const state = { kind: "copilot", sessionId: requested, model: null, effort: null };
  const call = runCopilot(state, "p", { cwd: "/dir" });

  if (expected === "ERR_ID" || expected === "ERR_MISMATCH") {
    await expect(call).rejects.toThrow(
      expected === "ERR_ID"
        ? "Copilot did not return a session ID."
        : "Copilot did not resume the expected session.",
    );
    expect(state.sessionId).toBe(requested);
  } else {
    await expect(call).resolves.toBe("ok");
    expect(state.sessionId).toBe(expected);
  }
});
