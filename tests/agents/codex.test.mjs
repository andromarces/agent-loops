import { expect, test, vi } from "vite-plus/test";
import { runCodex } from "../../src/agents/codex.mjs";
import { ExecError, exec } from "../../src/lib/exec.mjs";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";

// Only `exec` is replaced: the turn directory removal runs its helper through `execBounded`.
vi.mock("../../src/lib/exec.mjs", async (importActual) => ({
  ...(await importActual()),
  exec: vi.fn(),
}));

// Usefulness: verifies codex adapter sends exec, --json, and adds -c sandbox_mode="read-only" when readOnly is true on initial turn.
test("codex sends correct argv for initial turn with readOnly", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: events,
    stderr: "",
  });

  const state = { kind: "codex", sessionId: null, model: "gpt-4o", effort: "low" };
  const response = await runCodex(state, "prompt text", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("done");
  expect(state.sessionId).toBe("th-1");
  expect(exec).toHaveBeenCalledWith(
    "codex",
    [
      "exec",
      "-c",
      'sandbox_mode="read-only"',
      "--json",
      "-m",
      "gpt-4o",
      "-c",
      "model_reasoning_effort=low",
    ],
    {
      cwd: "/dir",
      input: "prompt text",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: expect.objectContaining({ TMPDIR: expect.any(String) }),
      treeEnd: true,
    },
  );
});

// Usefulness: verifies a non-object JSON line (issue #1123) is skipped, so the turn yields the same result as without it.
test("codex skips a non-object JSON line between valid events", async () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"th-1"}',
    "null",
    "42",
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
  ].join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const response = await runCodex(state, "prompt text", { cwd: "/dir" });

  expect(response).toBe("done");
  expect(state.sessionId).toBe("th-1");
});

// Usefulness: verifies codex adapter resumes session and adds -c sandbox_mode="read-only" when readOnly is true on resume.
test("codex resumes session with readOnly", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: "resumed ok" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: events,
    stderr: "",
  });

  const state = { kind: "codex", sessionId: "th-1", model: null, effort: null };
  const response = await runCodex(state, "resume prompt", {
    cwd: "/dir",
    readOnly: true,
  });

  expect(response).toBe("resumed ok");
  expect(exec).toHaveBeenCalledWith(
    "codex",
    ["exec", "resume", "th-1", "-c", 'sandbox_mode="read-only"', "--json", "-"],
    {
      cwd: "/dir",
      input: "resume prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: expect.objectContaining({ TMPDIR: expect.any(String) }),
      treeEnd: true,
    },
  );
});

// Usefulness: verifies Codex turn-completed token counts reach transcript invocation events through state.usage.
test("codex maps turn-completed usage to the main loop", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-2" },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 40,
        cache_write_input_tokens: 10,
        output_tokens: 30,
        reasoning_output_tokens: 20,
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };

  await runCodex(state, "prompt", { cwd: "/dir" });

  expect(state.usage).toEqual({
    mainLoop: {
      input_tokens: 120,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
      output_tokens: 30,
      reasoning_output_tokens: 20,
    },
  });
});

// Usefulness: verifies Codex turns without token events do not retain usage from a prior turn.
test("codex removes usage when no turn-completed usage exists", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-3" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = {
    kind: "codex",
    sessionId: null,
    model: null,
    effort: null,
    usage: { mainLoop: { input_tokens: 1 } },
  };

  await runCodex(state, "prompt", { cwd: "/dir" });

  expect(state).not.toHaveProperty("usage");
});

// Usefulness: verifies a failed first turn keeps the thread id that `thread.started` printed
// before the failure, so the next turn resumes it (issue #360).
test("codex keeps the thread id from a failed first turn", async () => {
  const stdout = [
    { type: "thread.started", thread_id: "th-failed" },
    { type: "turn.failed", error: { message: "boom" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("th-failed");
});

// Usefulness: verifies a failed resumed turn never changes the stored id.
test("codex keeps the stored thread id when a resumed turn fails", async () => {
  const stdout = JSON.stringify({ type: "thread.started", thread_id: "th-other" });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: "th-stored", model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("th-stored");
});

const MISSING =
  "Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)";

const missingFailure = (overrides = {}) =>
  Object.assign(new Error("codex exited with code 1."), {
    exitCode: 1,
    stdout: "",
    stderr: MISSING,
    ...overrides,
  });

// Usefulness: verifies the exact Codex stderr for the requested thread marks the error (issue #360).
test.each([
  ["the bare line", MISSING],
  ["one LF", `${MISSING}\n`],
  ["one CRLF", `${MISSING}\r\n`],
])("codex flags a resume of a missing thread with %s", async (_name, stderr) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure({ stderr }));

  const state = { kind: "codex", sessionId: "gone", model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.sessionMissing).toBe(true);
});

// Usefulness: verifies a failure that overlaps the missing-thread text is not marked, because a
// wrong mark reruns a real failure as a first turn and can repeat its edits (issue #360).
test.each([
  ["a first turn", null, {}],
  ["another thread id", "other", {}],
  ["a longer message", "gone", { stderr: `stream error: ${MISSING} retrying` }],
  [
    "an extra stderr line",
    "gone",
    {
      stderr: `Error: 429 Too Many Requests
${MISSING}`,
    },
  ],
  ["another error code", "gone", { stderr: MISSING.replace("-32600", "-32603") }],
  ["stdout events", "gone", { stdout: '{"type":"thread.started","thread_id":"gone"}' }],
  ["a timeout", "gone", { timedOut: true }],
  ["a cancel", "gone", { isCanceled: true }],
  ["a signal", "gone", { isTerminated: true }],
  ["another exit code", "gone", { exitCode: 2 }],
  ["leading spaces", "gone", { stderr: ` ${MISSING}` }],
  ["trailing spaces", "gone", { stderr: `${MISSING} ` }],
  ["trailing spaces before the line ending", "gone", { stderr: `${MISSING} \n` }],
  ["a leading blank line", "gone", { stderr: `\n${MISSING}` }],
  ["a trailing blank line", "gone", { stderr: `${MISSING}\n\n` }],
  ["two CRLF line endings", "gone", { stderr: `${MISSING}\r\n\r\n` }],
  ["a bare carriage return", "gone", { stderr: `${MISSING}\r` }],
  ["a tab", "gone", { stderr: `${MISSING}\t` }],
  ["whitespace on stdout", "gone", { stdout: "\n" }],
  ["a model error", "gone", { stderr: "The 'x' model is not supported" }],
])("codex does not flag %s", async (_name, sessionId, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure(overrides));

  const state = { kind: "codex", sessionId, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.sessionMissing).toBeUndefined();
  if (sessionId) expect(state.sessionId).toBe(sessionId);
});

// Usefulness: verifies a first turn that reports a thread and then fails response validation keeps
// the thread id, as issue #360 requires of every adapter error path.
test("codex keeps the thread id when a first turn fails response validation", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: '{"type":"thread.started","thread_id":"th-validated"}',
    stderr: "",
  });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("agent message");
  expect(state.sessionId).toBe("th-validated");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("codex rejects %s as the reported session id", async (_name, id) => {
  const stdout = [
    { type: "thread.started", thread_id: id },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "codex", sessionId: null, model: null, effort: null };
  await expect(runCodex(first, "p", { cwd: "/dir" })).rejects.toThrow(
    "Codex did not return a thread ID.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "codex", sessionId: "stored", model: null, effort: null };
  await expect(runCodex(resumed, "p", { cwd: "/dir" })).rejects.toThrow(
    "Codex did not return a thread ID.",
  );
  expect(resumed.sessionId).toBe("stored");
});

// Usefulness: verifies the adapter selects the id from the first thread.started event (an empty id fails), then validates
// that selected id, so a later valid id never rescues an invalid or mismatched selected one. A
// resumed turn keeps its stored id on every failure (issue #360).
test.each([
  ["invalid then valid, first turn", [42, "good"], null, "ERR_ID"],
  ["empty then valid, first turn", ["", "good"], null, "ERR_ID"],
  ["valid then different valid, first turn", ["a", "b"], null, "a"],
  ["invalid then stored, resumed turn", [42, "stored"], "stored", "ERR_ID"],
  ["different then stored, resumed turn", ["other", "stored"], "stored", "ERR_MISMATCH"],
  ["stored then different, resumed turn", ["stored", "other"], "stored", "stored"],
  ["empty then stored, resumed turn", ["", "stored"], "stored", "ERR_ID"],
])("codex selects then validates the id: %s", async (_name, ids, requested, expected) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      ...ids.map((id) => ({ type: "thread.started", thread_id: id })),
      { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    stderr: "",
  });
  const state = { kind: "codex", sessionId: requested, model: null, effort: null };
  const call = runCodex(state, "p", { cwd: "/dir" });

  if (expected === "ERR_ID" || expected === "ERR_MISMATCH") {
    await expect(call).rejects.toThrow(
      expected === "ERR_ID"
        ? "Codex did not return a thread ID."
        : "Codex did not resume the expected thread.",
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

// Usefulness: verifies a late agent message with no closing block does not replace the earlier block of the turn (issue #449).
test("codex returns the earlier closing block when the last message holds none", async () => {
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: `Work done.\n${BLOCK}` } },
    { type: "item.completed", item: { type: "agent_message", text: "Noted the late event." } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const response = await runCodex(state, "p", { cwd: "/dir" });

  expect(response).toBe(`Work done.\n${BLOCK}`);
});

// Usefulness: verifies a final malformed reject block wins over an earlier accept, so the parent sees it as raw and never an accept (issue #449).
test("codex keeps a final unparseable reject block over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const reject = "Conclusion: no.\nWhy: bugs.\nBlockers: see below\n* one\n* two\nVerdict: reject";
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: accept } },
    { type: "item.completed", item: { type: "agent_message", text: reject } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const response = await runCodex(state, "p", { cwd: "/dir" });

  expect(response).toBe(reject);
  expect(parseReportBlock(response)).toBeNull();
  expect(parseVerdict(response)).not.toBe("accept");
});

// Usefulness: verifies a final spaceless numbered report that the parser cannot read still wins over an earlier accept and surfaces as raw (issue #449).
test("codex keeps a final spaceless numbered report over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const numbered = "1.Conclusion: no.\n2.Why: bugs.\n3.Blockers: one\n4.Verdict: reject";
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: accept } },
    { type: "item.completed", item: { type: "agent_message", text: numbered } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const response = await runCodex(state, "p", { cwd: "/dir" });

  expect(response).toBe(numbered);
  expect(parseVerdict(response)).not.toBe("accept");
});

// Usefulness: verifies a final report whose labels follow letters in list items still wins over an earlier accept and surfaces as raw (issue #449).
test("codex keeps a final letter-prefixed list report over an earlier accept block", async () => {
  const accept = `${BLOCK}\nVerdict: accept`;
  const lettered = "a.Conclusion: ok.\nb.Why: w.\nc.Blockers: none\na) Verdict: accept";
  const events = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "item.completed", item: { type: "agent_message", text: accept } },
    { type: "item.completed", item: { type: "agent_message", text: lettered } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  vi.mocked(exec).mockResolvedValueOnce({ stdout: events, stderr: "" });

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const response = await runCodex(state, "p", { cwd: "/dir" });

  expect(response).toBe(lettered);
  expect(parseVerdict(response)).toBe("unknown");
});

// Usefulness: verifies the reviewer-only sandbox input gives a Codex turn the workspace-write
// sandbox with network access set off explicitly, so a user config that turns it on cannot widen
// the turn (issue #421). A readOnly turn with no sandbox input keeps read-only (tests above).
test.each([
  ["initial", null, ["exec"]],
  ["resume", "th-1", ["exec", "resume", "th-1"]],
])("codex %s turn with the workspace-write sandbox input", async (_name, sessionId, head) => {
  vi.mocked(exec).mockClear();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: [
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { type: "agent_message", text: "ok" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
    stderr: "",
  });

  const state = { kind: "codex", sessionId, model: null, effort: null };
  await runCodex(state, "p", { cwd: "/dir", readOnly: true, sandbox: "workspace-write" });

  expect(vi.mocked(exec).mock.calls[0][1]).toEqual([
    ...head,
    "-c",
    'sandbox_mode="workspace-write"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "--json",
    ...(sessionId ? ["-"] : []),
  ]);
});

// Usefulness: verifies the reviewer sandbox input "none" runs the Codex turn with no sandbox and with
// the app connectors off, in the same `-c` form on new and resumed sessions (ADR 0038, issue #496),
// and that an explicit "read-only" input keeps the present read-only invocation. Both are cheap to
// break and none is covered above.
test.each([
  ["initial", null, ["exec"]],
  ["resume", "th-1", ["exec", "resume", "th-1"]],
])(
  "codex %s turn passes the sandbox mode of the reviewer input",
  async (_name, sessionId, head) => {
    const run = async (sandbox) => {
      vi.mocked(exec).mockClear();
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: [
          { type: "thread.started", thread_id: "th-1" },
          { type: "item.completed", item: { type: "agent_message", text: "ok" } },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n"),
        stderr: "",
      });
      const state = { kind: "codex", sessionId, model: null, effort: null };
      await runCodex(state, "p", { cwd: "/dir", readOnly: true, sandbox });
      return vi.mocked(exec).mock.calls[0][1];
    };
    const tail = ["--json", ...(sessionId ? ["-"] : [])];

    expect(await run("none")).toEqual([
      ...head,
      "-c",
      'sandbox_mode="danger-full-access"',
      "-c",
      "features.apps=false",
      ...tail,
    ]);
    expect(await run("read-only")).toEqual([...head, "-c", 'sandbox_mode="read-only"', ...tail]);
  },
);

const CAPACITY = "Selected model is at capacity. Please try a different model.";

const capacityStdout = (overrides = {}) =>
  [
    { type: "thread.started", thread_id: "th-cap" },
    { type: "error", message: CAPACITY },
    { type: "turn.failed", error: { message: CAPACITY } },
  ]
    .map((event) => JSON.stringify({ ...event, ...overrides }))
    .join("\n");

// Usefulness: verifies requirement "a Codex model capacity failure is marked transient" (issue #1012), so a parent retries without parsing the error text; the thread id of the failed turn is still kept.
test.each([
  ["both events", capacityStdout()],
  [
    "the turn.failed event alone",
    JSON.stringify({ type: "turn.failed", error: { message: CAPACITY } }),
  ],
  ["the error event alone", JSON.stringify({ type: "error", message: CAPACITY })],
])("codex marks a capacity failure transient from %s", async (_name, stdout) => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.transient).toBe("capacity");
});

// Usefulness: verifies a failure that is not the capacity reply stays unmarked, because a wrong mark makes a parent retry a real reviewer fault.
test.each([
  [
    "another turn.failed message",
    JSON.stringify({ type: "turn.failed", error: { message: "The 'x' model is not supported" } }),
    {},
  ],
  [
    "the capacity text in an agent message",
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: CAPACITY } }),
    {},
  ],
  ["a timeout", capacityStdout(), { timedOut: true }],
  ["a cancel", capacityStdout(), { isCanceled: true }],
  ["a signal", capacityStdout(), { isTerminated: true }],
  ["no events", "", {}],
])("codex does not mark %s transient", async (_name, stdout, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), {
      exitCode: 1,
      stdout,
      stderr: "",
      ...overrides,
    }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.transient).toBeUndefined();
});

// Usefulness: verifies requirement "only a turn whose terminal failure is the capacity reply is marked transient" (issue #1012): an earlier capacity event followed by another terminal cause must not make a parent retry a real fault.
test.each([
  [
    "an error event then a turn.failed with another cause",
    [
      { type: "error", message: CAPACITY },
      { type: "turn.failed", error: { message: "Authentication failed" } },
    ],
  ],
  [
    "a capacity turn.failed then a later error with another cause",
    [
      { type: "turn.failed", error: { message: CAPACITY } },
      { type: "error", message: "Authentication failed" },
    ],
  ],
])("codex does not mark a capacity event that %s", async (_name, events) => {
  const stdout = events.map((event) => JSON.stringify(event)).join("\n");
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.transient).toBeUndefined();
});

const MODEL_REFUSAL =
  "The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.";

// Usefulness: verifies #1565 — the adapter names the refused model on the error, so the parent can
// run role set-model without reading the error text, and the refusal is not marked transient.
test("codex names the refused model on a model refusal", async () => {
  const stdout = [
    { type: "thread.started", thread_id: "th-refused" },
    { type: "error", message: MODEL_REFUSAL },
    { type: "turn.failed", error: { message: MODEL_REFUSAL } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { exitCode: 1, stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: "gpt-6.1", effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.refusedModel).toBe("gpt-6.1");
  expect(caught.transient).toBeUndefined();
  expect(state.sessionId).toBe("th-refused");
});

// Usefulness: verifies #1565 — only the terminal failure message marks a refusal; another cause,
// a message that only quotes the refusal, and a timeout stay unmarked, so no other first-turn
// failure is treated as a model refusal.
test.each([
  [
    "another cause",
    JSON.stringify({ type: "turn.failed", error: { message: "Authentication failed" } }),
    {},
  ],
  [
    "the refusal text in an agent message",
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: MODEL_REFUSAL },
    }),
    {},
  ],
  [
    "a timeout",
    JSON.stringify({ type: "turn.failed", error: { message: MODEL_REFUSAL } }),
    { timedOut: true },
  ],
])("codex does not mark %s as a model refusal", async (_name, stdout, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), {
      exitCode: 1,
      stdout,
      stderr: "",
      ...overrides,
    }),
  );

  const state = { kind: "codex", sessionId: null, model: "gpt-6.1", effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);
  expect(caught.refusedModel).toBeUndefined();
});

const AGGREGATED_SENTINEL = "AGGREGATED-OUTPUT-SENTINEL";

const largeStream = (events) =>
  [
    { type: "thread.started", thread_id: "th-bounded" },
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        aggregated_output: AGGREGATED_SENTINEL + "x".repeat(100_000),
      },
    },
    ...events,
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

// The real `exec` error message carries the whole stream after the cause.
const streamFailure = (stdout, overrides = {}) =>
  new ExecError(`codex exited with code 1.\n\n${stdout}`, {
    command: "codex",
    exitCode: 1,
    stdout,
    stderr: "",
    ...overrides,
  });

// Usefulness: verifies requirement "a non-zero exit with a large JSONL stream gives a bounded error
// that names the last failure message" (issue #1353). A failed turn therefore cannot put the stream
// in the envelope.
test("codex bounds a failed turn error and names the last failure message", async () => {
  const stdout = largeStream([
    { type: "turn.failed", error: { message: "The 'x' model is not supported" } },
  ]);
  vi.mocked(exec).mockRejectedValueOnce(streamFailure(stdout));

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.message).toContain("The 'x' model is not supported");
  expect(caught.message).toContain(`${Buffer.byteLength(stdout)} stdout bytes`);
  expect(caught.message.length).toBeLessThan(700);
});

// Usefulness: verifies the last failure message is itself bounded (issue #1353), because a provider
// message can hold command output too.
test("codex bounds a large last failure message", async () => {
  const stdout = largeStream([{ type: "error", message: `failure detail ${"x".repeat(5000)}` }]);
  vi.mocked(exec).mockRejectedValueOnce(streamFailure(stdout));

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);

  const detail = caught.message.match(/^codex exited with code 1: (.*) \(\d+ stdout bytes/)?.[1];
  expect(detail).toHaveLength(500);
  expect(caught.message).toContain("failure detail");
  expect(caught.message.length).toBeLessThan(700);
});

// Usefulness: verifies requirement "a capacity failure still carries transient capacity" while the
// error text is bounded. The #1012 behavior therefore does not depend on the reported text.
test("codex keeps the capacity mark on a bounded failure", async () => {
  const stdout = largeStream([
    { type: "error", message: CAPACITY },
    { type: "turn.failed", error: { message: CAPACITY } },
  ]);
  vi.mocked(exec).mockRejectedValueOnce(streamFailure(stdout));

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.transient).toBe("capacity");
  expect(caught.message).toContain(CAPACITY);
  expect(caught.message.length).toBeLessThan(700);
});

// Usefulness: verifies requirement "the error holds no aggregated_output text" (issue #1353).
// Content that a turn read therefore cannot reach the envelope or the state file.
test("codex keeps command output out of a failed turn error", async () => {
  const stdout = largeStream([
    { type: "turn.failed", error: { message: "The 'x' model is not supported" } },
  ]);
  vi.mocked(exec).mockRejectedValueOnce(streamFailure(stdout));

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.message).not.toContain(AGGREGATED_SENTINEL);
});

// Usefulness: verifies requirement "a stream with no error or turn.failed event still gives a
// bounded error" (issue #1353). An unfamiliar failure therefore never leaks the stream.
test("codex bounds an error when the stream names no failure event", async () => {
  const stdout = largeStream([]);
  vi.mocked(exec).mockRejectedValueOnce(streamFailure(stdout));

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  const caught = await runCodex(state, "p", { cwd: "/dir" }).catch((e) => e);

  expect(caught.message.length).toBeLessThan(700);
  expect(caught.message).not.toContain(AGGREGATED_SENTINEL);
});
