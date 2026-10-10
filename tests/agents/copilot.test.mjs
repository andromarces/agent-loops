import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runCopilot } from "../../src/agents/copilot.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";
import { verifyResolvedModels } from "../../src/lib/continuation.mjs";
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

// Usefulness: verifies a failed first turn keeps the session id the CLI reported in its result event, and keeps none when the failed output reports none and saved no turn (issue #360, ADR 0030).
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

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a number or an object, fails the turn with a clear error instead of returning success with no stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
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

// Usefulness: verifies the adapter selects the id from the last result event, then validates that selected id, so a later valid id never rescues an invalid or mismatched selected one. A resumed turn keeps its stored id on every failure (issue #360).
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

const BLOCK = [
  "Conclusion: done.",
  "Why: tests pass.",
  "Blockers: none",
  "Checks: pnpm test, passed.",
].join("\n");

// Usefulness: verifies a late assistant message with no closing block does not replace the earlier block of the turn (issue #449).
test("copilot returns the earlier closing block when the last message holds none", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      JSON.stringify({ type: "assistant.message", data: { content: `Work done.\n${BLOCK}` } }),
      JSON.stringify({ type: "assistant.message", data: { content: "Noted the late event." } }),
      '{"type":"result","sessionId":"s-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "s-1", model: null, effort: null };
  const response = await runCopilot(state, "p", { cwd: "/dir" });

  expect(response).toBe(`Work done.\n${BLOCK}`);
});

// Usefulness: verifies a final malformed reject block wins over an earlier accept, so the parent sees it as raw and never an accept (issue #449).
test("copilot keeps a final unparseable reject block over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const reject = "Conclusion: no.\nWhy: bugs.\nBlockers:\n- one\n- two\nVerdict: reject";
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      JSON.stringify({ type: "assistant.message", data: { content: accept } }),
      JSON.stringify({ type: "assistant.message", data: { content: reject } }),
      '{"type":"result","sessionId":"s-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "s-1", model: null, effort: null };
  const response = await runCopilot(state, "p", { cwd: "/dir" });

  expect(response).toBe(reject);
  expect(parseReportBlock(response)).toBeNull();
  expect(parseVerdict(response)).not.toBe("accept");
});

// Usefulness: verifies a final spaceless numbered report that the parser cannot read still wins over an earlier accept and surfaces as raw (issue #449).
test("copilot keeps a final spaceless numbered report over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const numbered = "1.Conclusion: no.\n2.Why: bugs.\n3.Blockers: one\n4.Verdict: reject";
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      JSON.stringify({ type: "assistant.message", data: { content: accept } }),
      JSON.stringify({ type: "assistant.message", data: { content: numbered } }),
      '{"type":"result","sessionId":"s-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "s-1", model: null, effort: null };
  const response = await runCopilot(state, "p", { cwd: "/dir" });

  expect(response).toBe(numbered);
  expect(parseVerdict(response)).not.toBe("accept");
});

// Usefulness: verifies a final report whose labels follow letters in list items still wins over an earlier accept and surfaces as raw (issue #449).
test("copilot keeps a final letter-prefixed list report over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const lettered = "a.Conclusion: ok.\nb.Why: w.\nc.Blockers: none\na) Verdict: accept";
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      JSON.stringify({ type: "assistant.message", data: { content: accept } }),
      JSON.stringify({ type: "assistant.message", data: { content: lettered } }),
      '{"type":"result","sessionId":"s-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  });

  const state = { kind: "copilot", sessionId: "s-1", model: null, effort: null };
  const response = await runCopilot(state, "p", { cwd: "/dir" });

  expect(response).toBe(lettered);
  expect(parseVerdict(response)).toBe("unknown");
});

// Usefulness: verifies the reviewer-only Codex sandbox input changes no copilot invocation, so the opt-in reaches Codex alone (issue #421).
test("copilot invocation is identical with the reviewer sandbox input on and off", async () => {
  vi.mocked(exec).mockClear();
  const reply = {
    stdout: [
      '{"type":"assistant.message","data":{"content":"ok"}}',
      '{"type":"result","sessionId":"copilot-sess-1","exitCode":0}',
    ].join("\n"),
    stderr: "",
  };
  vi.mocked(exec).mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  const turn = (extra) =>
    runCopilot({ kind: "copilot", sessionId: "copilot-sess-1", model: null, effort: null }, "p", {
      cwd: "/dir",
      readOnly: true,
      ...extra,
    });

  await turn({});
  await turn({ sandbox: "workspace-write" });

  const [off, on] = vi.mocked(exec).mock.calls;
  expect(on).toEqual(off);
});

const message = (data) =>
  JSON.stringify({ type: "assistant.message", data: { content: "a", ...data } });
const resolvedFrom = async (
  messages,
  state = { kind: "copilot", sessionId: null, model: null },
) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [...messages, '{"type":"result","sessionId":"s1","exitCode":0}'].join("\n"),
    stderr: "",
  });
  await runCopilot(state, "p", { cwd: "/dir" });
  return state.resolvedModel;
};

// Usefulness: --continue-from compares the model Copilot resolved, which its assistant messages name; one model across the messages is unambiguous.
test("copilot records the one model its assistant messages name as resolvedModel", async () => {
  expect(await resolvedFrom([message({ model: "m-1" }), message({ model: "m-1" })])).toBe("m-1");
  expect(await resolvedFrom([message({ model: "m-1" }), message({})])).toBe("m-1");
});

// Usefulness: a false resolved model would refuse or pass a continuation wrongly, so messages that name different models, and every malformed `model` value, record none.
test.each([
  ["different models", [message({ model: "m-1" }), message({ model: "m-2" })]],
  ["no model", [message({})]],
  ["an empty model", [message({ model: "" })]],
  ["a blank model", [message({ model: "  " })]],
  ["a number", [message({ model: 7 })]],
  ["an object", [message({ model: {} })]],
  ["a valid model beside a malformed one", [message({ model: "m-1" }), message({ model: 7 })]],
  ["a model with whitespace", [message({ model: "m 1" })]],
])("copilot marks the turn unresolved for %s", async (_label, messages) => {
  expect(await resolvedFrom(messages)).toBeNull();
});

// Usefulness: the record describes the latest turn, so a turn with unreadable or ambiguous evidence replaces an earlier model with unresolved (null) instead of leaving a stale model that a later --continue-from would compare against.
test.each([
  ["no model", [message({})]],
  ["different models", [message({ model: "m-2" }), message({ model: "m-3" })]],
  ["a malformed model", [message({ model: 7 })]],
])(
  "copilot replaces the earlier resolvedModel with unresolved for %s",
  async (_label, messages) => {
    const state = { kind: "copilot", sessionId: null, model: null, resolvedModel: "m-1" };
    expect(await resolvedFrom(messages, state)).toBeNull();
  },
);

test("copilot replaces the earlier resolvedModel when a turn names another single model", async () => {
  const state = { kind: "copilot", sessionId: null, model: null, resolvedModel: "m-1" };
  expect(await resolvedFrom([message({ model: "m-2" })], state)).toBe("m-2");
});

const copilotFailure = (overrides = {}) =>
  Object.assign(new Error("copilot exited with code 1."), {
    name: "ExecError",
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    isCanceled: false,
    isTerminated: false,
    ...overrides,
  });

const recordedState = () => ({
  kind: "copilot",
  sessionId: null,
  model: null,
  resolvedModel: "m-1",
});

// Usefulness: the session ran on the model a failed turn names, so the record must follow it (review probe: the record kept A while the failed turn named B).
test("copilot records the model a failed turn names, replacing the earlier one", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    copilotFailure({
      stdout: [message({ model: "m-2" }), '{"type":"result","sessionId":"s1"}'].join("\n"),
    }),
  );
  const state = recordedState();
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.resolvedModel).toBe("m-2");
});

// Usefulness: a turn that ran and named no single model may have run on another model, so the record becomes unresolved on every failure path: a non-zero exit with no or ambiguous output, a timeout, a cancel, a signal, and an exit 0 with no result event.
test.each([
  ["a non-zero exit with no output", copilotFailure()],
  [
    "a non-zero exit with different models",
    copilotFailure({ stdout: [message({ model: "m-2" }), message({ model: "m-3" })].join("\n") }),
  ],
  ["a timeout", copilotFailure({ timedOut: true })],
  ["a cancel", copilotFailure({ isCanceled: true })],
  ["a signal", copilotFailure({ isTerminated: true, exitCode: undefined })],
])("copilot marks the record unresolved after %s", async (_label, failure) => {
  vi.mocked(exec).mockRejectedValueOnce(failure);
  const state = recordedState();
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

test("copilot marks the record unresolved after an exit 0 with no result event", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: "garbage", stderr: "" });
  const state = recordedState();
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("session ID");
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: the record describes the session the role keeps. A turn whose output reports no session cannot be tied to the kept session, so the record is unresolved even when the output names a model.
test("copilot marks the record unresolved when the output names no session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: message({ model: "m-2" }), stderr: "" });
  const state = recordedState();
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("session ID");
  expect(state.resolvedModel).toBeNull();
});

const turnOf = (sessionId, model) =>
  [message({ model }), JSON.stringify({ type: "result", sessionId, exitCode: 0 })].join("\n");

// Usefulness: reported outcome. A resumed turn whose result is another session naming B keeps the original session id, so the record must not become B (a continuation would refuse A and accept B against the kept session). The record is unresolved, so a continuation compares nothing.
test("copilot does not record the model of a session the role does not keep", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: turnOf("s-other", "m-2"), stderr: "" });
  const state = { ...recordedState(), sessionId: "s-kept" };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("did not resume");
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();

  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const now of ["m-1", "m-2"]) {
      const roles = {
        orchestrator: { kind: "codex", model: null, effort: null },
        worker: { ...state },
        reviewer: { kind: "agy", model: null, effort: null },
      };
      const probe = vi.fn(async (probed) => {
        probed.resolvedModel = now;
      });
      await expect(verifyResolvedModels(roles, { probe })).resolves.toBeUndefined();
      expect(probe).not.toHaveBeenCalled();
    }
  } finally {
    warn.mockRestore();
    info.mockRestore();
  }
});

// Usefulness: a resumed turn that reports the retained session records its model, and a first turn records the session it adopts.
test("copilot records the model of the retained or adopted session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: turnOf("s-kept", "m-2"), stderr: "" });
  const resumed = { ...recordedState(), sessionId: "s-kept" };
  await runCopilot(resumed, "p", { cwd: "/dir" });
  expect(resumed.resolvedModel).toBe("m-2");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: turnOf("s-new", "m-2"), stderr: "" });
  const first = recordedState();
  await runCopilot(first, "p", { cwd: "/dir" });
  expect(first.sessionId).toBe("s-new");
  expect(first.resolvedModel).toBe("m-2");
});

// Usefulness: the same session rule holds on a failed turn.
test.each([
  ["the retained session", "s-kept", "m-2"],
  ["another session", "s-other", null],
  ["no session", undefined, null],
])("copilot failed turn that reports %s", async (_label, reported, expected) => {
  const result = reported ? [JSON.stringify({ type: "result", sessionId: reported })] : [];
  vi.mocked(exec).mockRejectedValueOnce(
    copilotFailure({ stdout: [message({ model: "m-2" }), ...result].join("\n") }),
  );
  const state = { ...recordedState(), sessionId: "s-kept" };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBe(expected);
});

test("copilot failed first turn records the model only with the session it adopts", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    copilotFailure({
      stdout: [message({ model: "m-2" }), '{"type":"result","sessionId":"s-new"}'].join("\n"),
    }),
  );
  const adopted = recordedState();
  await expect(runCopilot(adopted, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(adopted.sessionId).toBe("s-new");
  expect(adopted.resolvedModel).toBe("m-2");

  vi.mocked(exec).mockRejectedValueOnce(copilotFailure({ stdout: message({ model: "m-2" }) }));
  const none = recordedState();
  await expect(runCopilot(none, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(none.sessionId).toBeNull();
  expect(none.resolvedModel).toBeNull();
});

// Usefulness: a process that never started ran no model, so the earlier record stays.
test("copilot leaves the record alone when the process never started", async () => {
  vi.mocked(exec).mockRejectedValueOnce(copilotFailure({ exitCode: undefined }));
  const state = recordedState();
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(state.resolvedModel).toBe("m-1");
});

const resultOf = (sessionId) => JSON.stringify({ type: "result", sessionId, exitCode: 0 });

// Usefulness: one consistent source. The adapter takes the session from the last result event, so a stream whose events name more than one session cannot tie its messages' model to the session the role keeps, and records unresolved. Before, a first result of another session was ignored and the model was recorded for the retained session.
test.each([
  [
    "two result events of different sessions",
    [message({ model: "m-2" }), resultOf("s-other"), resultOf("s-kept")],
  ],
  [
    "an event whose data names another session",
    [
      JSON.stringify({ type: "session.start", data: { sessionId: "s-other" } }),
      message({ model: "m-2" }),
      resultOf("s-kept"),
    ],
  ],
  [
    "an event with a malformed session",
    [JSON.stringify({ type: "x", session_id: 7 }), message({ model: "m-2" }), resultOf("s-kept")],
  ],
])("copilot records unresolved for %s", async (_label, lines) => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: lines.join("\n"), stderr: "" });
  const state = { ...recordedState(), sessionId: "s-kept" };
  await runCopilot(state, "p", { cwd: "/dir" }).catch(() => {});
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: a normal single-session stream still records its model, also when another event repeats the same session.
test("copilot records the model of a single-session stream", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      JSON.stringify({ type: "session.start", data: { sessionId: "s-kept" } }),
      message({ model: "m-2" }),
      resultOf("s-kept"),
    ].join("\n"),
    stderr: "",
  });
  const state = { ...recordedState(), sessionId: "s-kept" };
  await runCopilot(state, "p", { cwd: "/dir" });
  expect(state.resolvedModel).toBe("m-2");
});

// Usefulness: the same single-source rule holds on a failed turn.
test("copilot failed turn with mixed sessions records unresolved", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    copilotFailure({
      stdout: [message({ model: "m-2" }), resultOf("s-other"), resultOf("s-kept")].join("\n"),
    }),
  );
  const state = { ...recordedState(), sessionId: "s-kept" };
  await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

// Session files in a fake Copilot home, in the shape that Copilot CLI 1.0.96-2 writes (issue #642).
// `events` lists the event types of `events.jsonl`; null writes `workspace.yaml` only, as a failed
// first turn with a bad model leaves.
async function withCopilotHome(body) {
  const home = await mkdtemp(join(tmpdir(), "copilot-home-"));
  vi.stubEnv("COPILOT_HOME", home);
  const writeSession = async (id, events) => {
    const dir = join(home, "session-state", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "workspace.yaml"), `id: ${id}\n`);
    if (events) {
      await writeFile(
        join(dir, "events.jsonl"),
        events.map((type) => JSON.stringify({ type, data: {} })).join("\n"),
      );
    }
  };
  try {
    await body(writeSession, home);
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
}

const freshState = () => ({ kind: "copilot", sessionId: null, model: null, effort: null });

// Rejects like a failed first turn after the CLI saved a session under the pre-assigned id.
const failAfterSession = (writeSession, events, error) =>
  vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
    await writeSession(args[1], events);
    throw error;
  });

// Usefulness: a failed first turn that printed no id but left a session holding the turn keeps the pre-assigned id with the unconfirmed mark, so the next turn resumes it without the preamble (issue #642, ADR 0030).
test("a failed first copilot worker turn that saved a session keeps the pre-assigned id", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    failAfterSession(
      writeSession,
      ["session.start", "user.message", "tool.execution_start"],
      copilotFailure({ stdout: '{"type":"tool.execution_start","data":{}}' }),
    );
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => ({
      stdout: [
        '{"type":"assistant.message","data":{"content":"done"}}',
        `{"type":"result","sessionId":${JSON.stringify(String(args[1]))},"exitCode":0}`,
      ].join("\n"),
      stderr: "",
    }));

    const role = freshState();
    const first = await runChild({ role, roleName: "worker", prompt: "do the task", cwd: "/dir" });
    const preassigned = vi.mocked(exec).mock.calls[0][1][1];

    expect(first.status).toBe("error");
    expect(role.sessionId).toBe(preassigned);
    expect(role.sessionUnconfirmed).toBe(true);

    const second = await runChild({ role, roleName: "worker", prompt: "retry", cwd: "/dir" });

    expect(second.status).toBe("ok");
    expect(vi.mocked(exec).mock.calls[1][1][1]).toBe(preassigned);
    expect(vi.mocked(exec).mock.calls[1][2].input).not.toContain(
      "You are the implementation agent (worker)",
    );
    expect(role.sessionId).toBe(preassigned);
    expect(role.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: a failure that saved no user message, such as a bad model, an unsupported effort, or a kill before the prompt was recorded, leaves no stale id, so the next turn carries the preamble.
test.each([
  ["no session directory at all", undefined],
  ["a session directory with no events file (bad model)", null],
  ["an events file with no user message", ["session.start", "session.shutdown"]],
])("a failed first copilot turn keeps no id with %s", async (_name, events) => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
      if (events !== undefined) await writeSession(args[1], events);
      throw copilotFailure({ stdout: '{"type":"session.mcp_servers_loaded","data":{}}' });
    });
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBeNull();
    expect(state.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: an error in the middle of a model call ends the stream with no result event, like a kill does. The session file decides, so the saved turn is kept.
test("a first copilot turn that fails mid-turn with an error event keeps the pre-assigned id", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    failAfterSession(
      writeSession,
      ["session.start", "user.message", "assistant.turn_start"],
      copilotFailure({
        stdout: [
          '{"type":"assistant.turn_start","data":{}}',
          '{"type":"model.call_start","data":{}}',
          '{"type":"session.error","data":{"message":"model error"}}',
        ].join("\n"),
      }),
    );
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBe(vi.mocked(exec).mock.calls[0][1][1]);
    expect(state.sessionUnconfirmed).toBe(true);
  });
});

// Usefulness: a relative COPILOT_HOME resolves against the role cwd, as Copilot CLI 1.0.96-2 does (issue #678, ADR 0030), so the session that the CLI saved there is found and kept.
test("a failed first copilot turn keeps the id of a session under a relative COPILOT_HOME of the role cwd", async () => {
  const roleCwd = await mkdtemp(join(tmpdir(), "copilot-role-cwd-"));
  vi.stubEnv("COPILOT_HOME", "relative-home");
  try {
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
      const dir = join(roleCwd, "relative-home", "session-state", args[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "events.jsonl"),
        JSON.stringify({ type: "user.message", data: {} }),
      );
      throw copilotFailure({ stdout: '{"type":"tool.execution_start","data":{}}' });
    });
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: roleCwd })).rejects.toThrow();
    expect(state.sessionId).toBe(vi.mocked(exec).mock.calls[0][1][1]);
    expect(state.sessionUnconfirmed).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await rm(roleCwd, { recursive: true, force: true });
  }
});

// Usefulness: a process that never started saved nothing, so a session file under the id (a stale one from another run) cannot make the adapter keep it.
test("a first copilot turn whose process never started keeps no id", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    failAfterSession(
      writeSession,
      ["session.start", "user.message"],
      copilotFailure({ exitCode: undefined }),
    );
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBeNull();
  });
});

// Usefulness: an id that the result event reports is confirmed, so it wins over the pre-assigned id and carries no mark.
test("a failed first copilot turn keeps a reported id without the unconfirmed mark", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    failAfterSession(
      writeSession,
      ["session.start", "user.message"],
      copilotFailure({ stdout: '{"type":"result","sessionId":"copilot-reported","exitCode":1}' }),
    );
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBe("copilot-reported");
    expect(state.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: an unconfirmed id whose session file is gone (the store was cleared) is refused before any CLI starts, so the runtime reruns the turn as a first turn with the preamble.
test("a worker turn reruns as a first turn when the unconfirmed copilot session is gone", async () => {
  await withCopilotHome(async () => {
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => ({
      stdout: [
        '{"type":"assistant.message","data":{"content":"done"}}',
        `{"type":"result","sessionId":${JSON.stringify(String(args[1]))},"exitCode":0}`,
      ].join("\n"),
      stderr: "",
    }));
    const stale = "44444444-4444-4444-8444-444444444444";
    const role = { ...freshState(), sessionId: stale, sessionUnconfirmed: true };

    const result = await runChild({ role, roleName: "worker", prompt: "retry", cwd: "/dir" });

    expect(result.status).toBe("ok");
    expect(vi.mocked(exec)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exec).mock.calls[0][1][1]).not.toBe(stale);
    expect(vi.mocked(exec).mock.calls[0][2].input).toContain(
      "You are the implementation agent (worker)",
    );
    expect(role.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: a confirmed id resumes with no session file check, so a CLI that keeps its sessions elsewhere is never refused for an id that its own output reported.
test("copilot resumes a confirmed id without a session file", async () => {
  await withCopilotHome(async () => {
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: [
        '{"type":"assistant.message","data":{"content":"ok"}}',
        '{"type":"result","sessionId":"copilot-confirmed","exitCode":0}',
      ].join("\n"),
      stderr: "",
    });
    const state = { ...freshState(), sessionId: "copilot-confirmed" };
    await expect(runCopilot(state, "p", { cwd: "/dir" })).resolves.toBe("ok");
  });
});

const SAVED = ["session.start", "user.message"];

// Usefulness: an id that the failed output reports but that is not a valid session id stores nothing on a first turn, even when a turn was saved under the pre-assigned id (ADR 0027 decision 1, ADR 0030 decision 1).
test.each([
  ["an empty string", ""],
  ["a number", 42],
  ["an object", { id: "x" }],
])("a failed first copilot turn that reports %s as its id keeps none", async (_name, id) => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    failAfterSession(
      writeSession,
      SAVED,
      copilotFailure({ stdout: JSON.stringify({ type: "result", sessionId: id, exitCode: 1 }) }),
    );
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBeNull();
    expect(state.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: a successful exit whose result id is not a valid session id stores nothing on a first turn, even when a turn was saved under the pre-assigned id.
test("a first copilot turn whose exit 0 result reports an invalid id keeps none", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    vi.mocked(exec).mockImplementationOnce(async (_command, args) => {
      await writeSession(args[1], SAVED);
      return {
        stdout: [
          '{"type":"assistant.message","data":{"content":"ok"}}',
          '{"type":"result","sessionId":42,"exitCode":0}',
        ].join("\n"),
        stderr: "",
      };
    });
    const state = freshState();
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow("session ID");
    expect(state.sessionId).toBeNull();
    expect(state.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: the mark clears only for the id that a result confirms, so a result of another id never lets a later resume skip the session check for the retained id.
test.each([
  ["succeeds", async (id) => ({ stdout: [message({ model: "m" }), resultOf(id)].join("\n") })],
  ["fails", async (id) => Promise.reject(copilotFailure({ stdout: resultOf(id) }))],
])(
  "a resumed unconfirmed copilot turn that %s with another id keeps the mark",
  async (_name, answer) => {
    await withCopilotHome(async (writeSession) => {
      vi.mocked(exec).mockReset();
      const kept = "55555555-5555-4555-8555-555555555555";
      await writeSession(kept, SAVED);
      vi.mocked(exec).mockImplementationOnce(() => answer("copilot-other"));
      const state = { ...freshState(), sessionId: kept, sessionUnconfirmed: true };
      await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
      expect(state.sessionId).toBe(kept);
      expect(state.sessionUnconfirmed).toBe(true);
    });
  },
);

// Usefulness: a resumed unconfirmed turn that reports its own id is confirmed, so the mark clears on a failure as on a success.
test("a resumed unconfirmed copilot turn that fails with its own id clears the mark", async () => {
  await withCopilotHome(async (writeSession) => {
    vi.mocked(exec).mockReset();
    const kept = "66666666-6666-4666-8666-666666666666";
    await writeSession(kept, SAVED);
    vi.mocked(exec).mockRejectedValueOnce(copilotFailure({ stdout: resultOf(kept) }));
    const state = { ...freshState(), sessionId: kept, sessionUnconfirmed: true };
    await expect(runCopilot(state, "p", { cwd: "/dir" })).rejects.toThrow();
    expect(state.sessionId).toBe(kept);
    expect(state.sessionUnconfirmed).toBeUndefined();
  });
});

// Usefulness: a symlinked session directory or events file is never followed out of the session store, as the Claude ownership check refuses a symlinked project directory or session file.
test.for([
  ["a symlinked session directory", "dir"],
  ["a symlinked events file", "file"],
])("copilot finds no saved turn behind %s", async ([_name, kind], ctx) => {
  await withCopilotHome(async (writeSession, home) => {
    vi.mocked(exec).mockReset();
    const id = "77777777-7777-4777-8777-777777777777";
    const real = "88888888-8888-4888-8888-888888888888";
    await writeSession(real, SAVED);
    const store = join(home, "session-state");
    try {
      if (kind === "dir") {
        await symlink(join(store, real), join(store, id), "junction");
      } else {
        await mkdir(join(store, id));
        await symlink(join(store, real, "events.jsonl"), join(store, id, "events.jsonl"), "file");
      }
    } catch (err) {
      if (err?.code === "EPERM") ctx.skip();
      throw err;
    }
    const caught = await runCopilot(
      { ...freshState(), sessionId: id, sessionUnconfirmed: true },
      "p",
      {
        cwd: "/dir",
      },
    ).catch((e) => e);
    expect(caught.sessionMissing).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});
