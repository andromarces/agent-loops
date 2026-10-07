import { expect, test, vi } from "vite-plus/test";
import { runClaude } from "../../src/agents/claude.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
  exec: vi.fn(),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads the id the adapter pre-assigned on its latest `exec` call. */
function preassignedId() {
  const args = vi.mocked(exec).mock.calls.at(-1)[1];
  return args[args.indexOf("--session-id") + 1];
}

// Usefulness: verifies claude adapter sends -p, --output-format json, adds --permission-mode plan when
// readOnly is true, and disables the built-in Explore and Plan research subagents so a read-only turn
// does not spawn hidden subagents on the role model (issue #46). It also verifies a first turn
// pre-assigns a UUID with --session-id (issue #395).
test("claude sends correct argv for initial turn with readOnly", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: "claude-3-5", effort: null };
  const response = await runClaude(state, "test prompt", {
    cwd: "/path",
    readOnly: true,
  });

  expect(response).toBe("ok");
  expect(state.sessionId).toBe("s1");
  expect(preassignedId()).toMatch(UUID);
  expect(exec).toHaveBeenLastCalledWith(
    "claude",
    [
      "-p",
      "--session-id",
      preassignedId(),
      "--permission-mode",
      "plan",
      "--model",
      "claude-3-5",
      "--output-format",
      "json",
    ],
    {
      cwd: "/path",
      input: "test prompt",
      timeout: undefined,
      signal: undefined,
      role: undefined,
      env: { CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" },
    },
  );
});

// Usefulness: verifies claude adapter passes --resume and effort on resume turn, and leaves the worker
// environment untouched so the worker keeps its research subagents.
test("claude resumes session with effort and readOnly false", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ session_id: "s1", type: "result", result: "done" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s1", model: null, effort: "high" };
  const response = await runClaude(state, "follow up", {
    cwd: "/path",
    readOnly: false,
  });

  expect(response).toBe("done");
  expect(exec).toHaveBeenCalledWith(
    "claude",
    ["-p", "--resume", "s1", "--effort", "high", "--output-format", "json"],
    { cwd: "/path", input: "follow up", timeout: undefined, signal: undefined, role: undefined },
  );
});

// Usefulness: verifies the adapter exposes per-model usage, main-loop usage, and total cost from the
// result event as `state.usage`, so the transcript can attribute cost per invocation (issue #47).
test("claude exposes result usage on state", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({
      session_id: "s1",
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { "claude-opus-5": { inputTokens: 12, outputTokens: 6, costUSD: 0.01 } },
      total_cost_usd: 0.01,
    }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await runClaude(state, "p", { cwd: "/path", readOnly: false });

  expect(state.usage).toEqual({
    models: { "claude-opus-5": { inputTokens: 12, outputTokens: 6, costUSD: 0.01 } },
    mainLoop: { input_tokens: 10, output_tokens: 5 },
    totalCostUsd: 0.01,
  });
});

// Usefulness: verifies a result without usage fields leaves no stale usage on state.
test("claude clears state.usage when the result carries no usage", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ session_id: "s1", type: "result", result: "done" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s1", model: null, effort: null, usage: { stale: 1 } };
  await runClaude(state, "p", { cwd: "/path", readOnly: false });

  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies a failed CLI call that still printed a result event exposes its usage before
// the error propagates, so a failed invocation is not free in the transcript (issue #47).
test("claude exposes usage from stdout when the CLI exits non-zero", async () => {
  const stdout = JSON.stringify({
    session_id: "s1",
    type: "result",
    is_error: true,
    result: "boom",
    total_cost_usd: 0.02,
  });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null, usage: { stale: 1 } };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow(
    "claude exited with code 1.",
  );
  expect(state.usage).toEqual({ totalCostUsd: 0.02 });
});

// Usefulness: verifies a failure with unparseable stdout clears stale usage and rethrows.
test("claude clears stale usage when a failed call has no parseable stdout", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out after 5 seconds."), { stdout: "", stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null, usage: { stale: 1 } };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow(
    "timed out",
  );
  expect(state.usage).toBeUndefined();
});

// Usefulness: verifies a failed first turn that printed its session id keeps the id, so the next
// turn resumes that session and its edits (issue #360).
test("claude keeps the session id from a failed first turn", async () => {
  const stdout = JSON.stringify([
    { type: "system", subtype: "init", session_id: "s-failed" },
    { type: "result", is_error: true, session_id: "s-failed", result: "boom" },
  ]);
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("s-failed");
});

// Usefulness: verifies a failed resumed turn never changes the stored id.
test("claude keeps the stored session id when a resumed turn fails", async () => {
  const stdout = JSON.stringify({ type: "result", session_id: "s-other", result: "boom" });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "claude", sessionId: "s-stored", model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("s-stored");
});

// Usefulness: verifies a first turn that a timeout or cancel killed, with empty stdout, keeps the
// pre-assigned id, so the next turn resumes the session the CLI saved (issue #395).
test.each([
  ["a timeout", { timedOut: true }],
  ["a cancel", { isCanceled: true }],
  ["a signal", { isTerminated: true }],
])("claude keeps the pre-assigned session id when %s ends a first turn", async (_n, flags) => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude was stopped."), { stdout: "", stderr: "", ...flags }),
  );

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path", readOnly: false })).rejects.toThrow("stopped");
  expect(state.sessionId).toMatch(UUID);
  expect(state.sessionId).toBe(preassignedId());
});

// Usefulness: verifies the next turn after a killed first turn resumes the kept id and passes no
// --session-id, because the CLI refuses a new id for a resumed session (issue #395).
test("claude resumes the pre-assigned id kept from a killed first turn", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
  );
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("timed out");
  const kept = state.sessionId;

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: kept, result: "ok" }),
    stderr: "",
  });
  await expect(runClaude(state, "again", { cwd: "/path" })).resolves.toBe("ok");
  const args = vi.mocked(exec).mock.calls.at(-1)[1];
  expect(args).toEqual(expect.arrayContaining(["--resume", kept]));
  expect(args).not.toContain("--session-id");
});

// Usefulness: verifies a killed first turn whose session the CLI never saved still reaches the
// missing-session fallback on the next turn, and the rerun pre-assigns a new id (issue #395).
test("claude flags the resume of a pre-assigned id that the CLI never saved", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
  );
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("timed out");
  const kept = state.sessionId;

  vi.mocked(exec).mockRejectedValueOnce(
    missingFailure({ stderr: `No conversation found with session ID: ${kept}` }),
  );
  const caught = await runClaude(state, "again", { cwd: "/path" }).catch((e) => e);
  expect(caught.sessionMissing).toBe(true);

  state.sessionId = null;
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s-new", result: "ok" }),
    stderr: "",
  });
  await runClaude(state, "again", { cwd: "/path" });
  expect(preassignedId()).toMatch(UUID);
  expect(preassignedId()).not.toBe(kept);
});

// Usefulness: verifies a successful first turn adopts the id the CLI reports, even when it differs
// from the pre-assigned one, so the stored id is always one the CLI printed (issue #395).
test("claude adopts the reported id of a first turn over the pre-assigned id", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s-reported", result: "ok" }),
    stderr: "",
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await runClaude(state, "p", { cwd: "/path" });
  expect(state.sessionId).toBe("s-reported");
});

// Usefulness: verifies a resumed turn never gains a pre-assigned id, so a failed resumed turn keeps
// its stored id (issue #395).
test("claude pre-assigns no id on a resumed turn", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
  );
  const state = { kind: "claude", sessionId: "s-stored", model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("timed out");
  expect(vi.mocked(exec).mock.calls.at(-1)[1]).not.toContain("--session-id");
  expect(state.sessionId).toBe("s-stored");
});

const MISSING = "No conversation found with session ID: gone";

const missingFailure = (overrides = {}) =>
  Object.assign(new Error("claude exited with code 1."), {
    exitCode: 1,
    stdout: "",
    stderr: MISSING,
    ...overrides,
  });

// Usefulness: verifies the exact Claude Code stderr for the requested id marks the error, so the
// runtime reruns the turn as a first turn (issue #360).
test.each([
  ["the bare line", MISSING],
  ["one LF", `${MISSING}\n`],
  ["one CRLF", `${MISSING}\r\n`],
])("claude flags a resume of a missing session with %s", async (_name, stderr) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure({ stderr }));

  const state = { kind: "claude", sessionId: "gone", model: null, effort: null };
  const caught = await runClaude(state, "p", { cwd: "/path" }).catch((e) => e);
  expect(caught.sessionMissing).toBe(true);
});

// Usefulness: verifies a failure that overlaps the missing-session text is not marked, because a
// wrong mark reruns a real failure as a first turn and can repeat its edits (issue #360).
test.each([
  ["a first turn", null, {}],
  ["another session id", "other", {}],
  ["a longer message", "gone", { stderr: `API Error: 529 overloaded. ${MISSING} upstream` }],
  [
    "an extra stderr line",
    "gone",
    {
      stderr: `Error: rate limit
${MISSING}`,
    },
  ],
  ["stdout output", "gone", { stdout: "partial result" }],
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
  ["an auth failure", "gone", { stderr: "Invalid API key" }],
])("claude does not flag %s", async (_name, sessionId, overrides) => {
  vi.mocked(exec).mockRejectedValueOnce(missingFailure(overrides));

  const state = { kind: "claude", sessionId, model: null, effort: null };
  const caught = await runClaude(state, "p", { cwd: "/path" }).catch((e) => e);
  expect(caught.sessionMissing).toBeUndefined();
});

// Usefulness: verifies a resumed turn never changes its id: a different id in the result is
// refused and the stored id stays, as in the Codex, Copilot, and opencode adapters (issue #360).
test("claude refuses a different session id on a resumed turn", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s-other", result: "ok" }),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: "s-stored", model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not resume the expected session.",
  );
  expect(state.sessionId).toBe("s-stored");
});

// Usefulness: verifies a first turn whose result has no text keeps the reported session id, as
// issue #360 requires of every adapter error path. Claude has no later validation that fails the
// turn, so the id and an empty response both reach the caller.
test("claude keeps the session id of a first turn whose result has no text", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([{ type: "result", session_id: "s-empty" }]),
    stderr: "",
  });

  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).resolves.toBe("");
  expect(state.sessionId).toBe("s-empty");
});

// Usefulness: verifies a successful result whose session id is truthy but not a string, such as a
// number or an object, fails the turn with a clear error instead of returning success with no
// stored id. A first turn keeps no id, and a resumed turn keeps its stored id (issue #360).
test.each([
  ["a number", 42],
  ["an object", { id: "x" }],
])("claude rejects %s as the reported session id", async (_name, id) => {
  const stdout = JSON.stringify({ session_id: id, result: "ok" });
  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const first = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(first, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not return a session_id.",
  );
  expect(first.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({ stdout, stderr: "" });
  const resumed = { kind: "claude", sessionId: "stored", model: null, effort: null };
  await expect(runClaude(resumed, "p", { cwd: "/path" })).rejects.toThrow(
    "Claude Code did not return a session_id.",
  );
  expect(resumed.sessionId).toBe("stored");
});

// Usefulness: verifies the adapter selects the first truthy id (an empty id is skipped), then validates
// that selected id, so a later valid id never rescues an invalid or mismatched selected one. A
// resumed turn keeps its stored id on every failure (issue #360).
test.each([
  ["invalid then valid, first turn", [42, "good"], null, "ERR_ID"],
  ["empty then valid, first turn", ["", "good"], null, "good"],
  ["valid then different valid, first turn", ["a", "b"], null, "a"],
  ["invalid then stored, resumed turn", [42, "stored"], "stored", "ERR_ID"],
  ["different then stored, resumed turn", ["other", "stored"], "stored", "ERR_MISMATCH"],
  ["stored then different, resumed turn", ["stored", "other"], "stored", "stored"],
  ["empty then stored, resumed turn", ["", "stored"], "stored", "stored"],
])("claude selects then validates the id: %s", async (_name, ids, requested, expected) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify([
      ...ids.map((id) => ({ type: "system", session_id: id })),
      { type: "result", result: "ok" },
    ]),
    stderr: "",
  });
  const state = { kind: "claude", sessionId: requested, model: null, effort: null };
  const call = runClaude(state, "p", { cwd: "/path" });

  if (expected === "ERR_ID" || expected === "ERR_MISMATCH") {
    await expect(call).rejects.toThrow(
      expected === "ERR_ID"
        ? "Claude Code did not return a session_id."
        : "Claude Code did not resume the expected session.",
    );
    expect(state.sessionId).toBe(requested);
  } else {
    await expect(call).resolves.toBe("ok");
    expect(state.sessionId).toBe(expected);
  }
});

// Usefulness: verifies the reviewer-only Codex sandbox input changes no claude invocation, so the
// opt-in reaches Codex alone (issue #421).
test("claude invocation is identical with the reviewer sandbox input on and off", async () => {
  vi.mocked(exec).mockClear();
  const reply = { stdout: JSON.stringify({ session_id: "s1", result: "ok" }), stderr: "" };
  vi.mocked(exec).mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
  const turn = (extra) =>
    runClaude({ kind: "claude", sessionId: null, model: null, effort: null }, "p", {
      cwd: "/dir",
      readOnly: true,
      ...extra,
    });

  await turn({});
  await turn({ sandbox: "workspace-write" });

  // Each first turn pre-assigns its own random id, so compare the invocations without it.
  const [off, on] = vi.mocked(exec).mock.calls.map(([cmd, args, opts]) => {
    const at = args.indexOf("--session-id");
    return [cmd, args.filter((_, i) => i !== at && i !== at + 1), opts];
  });
  expect(on).toEqual(off);
});

const IN_USE = (id) => `Error: Session ID ${id} is already in use.`;

// Usefulness: verifies the adapter reports the pre-assigned id through `onSessionAssigned` before
// the CLI starts, so the dispatcher can persist it ahead of a crash (issue #395).
test("claude reports the pre-assigned id before it starts the CLI", async () => {
  const order = [];
  let assigned;
  vi.mocked(exec).mockImplementationOnce(async () => {
    order.push("exec");
    return { stdout: JSON.stringify({ session_id: "s1", result: "ok" }), stderr: "" };
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await runClaude(state, "p", {
    cwd: "/path",
    onSessionAssigned: async (id) => {
      assigned = id;
      order.push("assigned");
    },
  });
  expect(order).toEqual(["assigned", "exec"]);
  expect(assigned).toBe(preassignedId());

  // A resumed turn assigns nothing.
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });
  const onSessionAssigned = vi.fn();
  await runClaude(state, "p", { cwd: "/path", onSessionAssigned });
  expect(onSessionAssigned).not.toHaveBeenCalled();
});

// Usefulness: verifies a failed hook stops the turn before the CLI starts, so no unrecorded
// session exists (issue #395).
test("claude starts no CLI when the dispatcher cannot record the pre-assigned id", async () => {
  vi.mocked(exec).mockClear();
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(
    runClaude(state, "p", {
      cwd: "/path",
      onSessionAssigned: async () => {
        throw new Error("state write failed");
      },
    }),
  ).rejects.toThrow("state write failed");
  expect(exec).not.toHaveBeenCalled();
  expect(state.sessionId).toBeNull();
});

// Usefulness: verifies a first turn that the CLI rejects because the pre-assigned id belongs to an
// existing session keeps no id, so the next turn starts a fresh session and never resumes the
// unrelated one (issue #395).
test("claude never keeps a pre-assigned id that the CLI rejects as in use", async () => {
  vi.mocked(exec).mockImplementationOnce(async (_cmd, args) => {
    const id = args[args.indexOf("--session-id") + 1];
    throw Object.assign(new Error("claude exited with code 1."), {
      exitCode: 1,
      stdout: "",
      stderr: `${IN_USE(id)}\n`,
    });
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("exited");
  const rejected = preassignedId();
  expect(state.sessionId).toBeNull();

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s-fresh", result: "ok" }),
    stderr: "",
  });
  await runClaude(state, "p", { cwd: "/path" });
  const next = vi.mocked(exec).mock.calls.at(-1)[1];
  expect(next).not.toContain("--resume");
  expect(preassignedId()).toMatch(UUID);
  expect(preassignedId()).not.toBe(rejected);
});

// Usefulness: verifies only the exact in-use line for the pre-assigned id counts as a collision,
// so any other failed first turn still keeps its id for the resume (issue #395).
test.each([
  ["another id", () => IN_USE("other"), {}],
  ["a longer message", (id) => `warn ${IN_USE(id)}`, {}],
  ["a timeout", (id) => IN_USE(id), { timedOut: true }],
  ["stdout output", (id) => IN_USE(id), { stdout: "partial" }],
])("claude keeps the pre-assigned id when the failure is %s", async (_n, line, extra) => {
  vi.mocked(exec).mockImplementationOnce(async (_cmd, args) => {
    const id = args[args.indexOf("--session-id") + 1];
    throw Object.assign(new Error("claude exited with code 1."), {
      exitCode: 1,
      stdout: "",
      stderr: line(id),
      ...extra,
    });
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("exited");
  expect(state.sessionId).toMatch(UUID);
});
