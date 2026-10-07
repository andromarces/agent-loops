import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Usefulness: verifies the next turn after a killed first turn resumes the kept id when the CLI saved
// its session for this work tree, and passes no --session-id, because the CLI refuses a new id for a
// resumed session (issue #395).
test("claude resumes the pre-assigned id kept from a killed first turn", async () => {
  await withSessionStore(
    () => [],
    async (work) => {
      vi.mocked(exec).mockRejectedValueOnce(
        Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
      );
      const state = { kind: "claude", sessionId: null, model: null, effort: null };
      await expect(runClaude(state, "p", { cwd: work })).rejects.toThrow("timed out");
      const kept = state.sessionId;
      // The CLI saved the session of the killed turn.
      const config = process.env.CLAUDE_CONFIG_DIR;
      await mkdir(join(config, "projects", "-p"), { recursive: true });
      await writeFile(
        join(config, "projects", "-p", `${kept}.jsonl`),
        JSON.stringify({ type: "user", cwd: work, sessionId: kept }),
      );

      vi.mocked(exec).mockResolvedValueOnce({
        stdout: JSON.stringify({ session_id: kept, result: "ok" }),
        stderr: "",
      });
      await expect(runClaude(state, "again", { cwd: work })).resolves.toBe("ok");
      const args = vi.mocked(exec).mock.calls.at(-1)[1];
      expect(args).toEqual(expect.arrayContaining(["--resume", kept]));
      expect(args).not.toContain("--session-id");
    },
  );
});

// Usefulness: verifies a killed first turn whose session the CLI never saved is refused as missing
// before a resume, so the runtime reruns it as a first turn with a new pre-assigned id (issue #395).
test("claude flags the resume of a pre-assigned id that the CLI never saved", async () => {
  await withSessionStore(
    () => [],
    async (work) => {
      vi.mocked(exec).mockRejectedValueOnce(
        Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
      );
      const state = { kind: "claude", sessionId: null, model: null, effort: null };
      await expect(runClaude(state, "p", { cwd: work })).rejects.toThrow("timed out");
      const kept = state.sessionId;

      const caught = await runClaude(state, "again", { cwd: work }).catch((e) => e);
      expect(caught.sessionMissing).toBe(true);

      state.sessionId = null;
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: JSON.stringify({ session_id: "s-new", result: "ok" }),
        stderr: "",
      });
      await runClaude(state, "again", { cwd: work });
      expect(preassignedId()).toMatch(UUID);
      expect(preassignedId()).not.toBe(kept);
    },
  );
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

// Usefulness: verifies the adapter tells the dispatcher to drop a rejected pre-assigned id before it
// rethrows, so the id never outlives the rejection in a persisted state file, and that no other
// failure clears the id (issue #395).
test("claude clears the reported id through onSessionAssigned when the CLI rejects it as in use", async () => {
  const calls = [];
  vi.mocked(exec).mockImplementationOnce(async (_cmd, args) => {
    const id = args[args.indexOf("--session-id") + 1];
    throw Object.assign(new Error("claude exited with code 1."), {
      exitCode: 1,
      stdout: "",
      stderr: IN_USE(id),
    });
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await expect(
    runClaude(state, "p", { cwd: "/path", onSessionAssigned: async (id) => calls.push(id) }),
  ).rejects.toThrow("exited");
  expect(calls).toEqual([preassignedId(), null]);

  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
  );
  const other = [];
  await expect(
    runClaude({ ...state, sessionId: null }, "p", {
      cwd: "/path",
      onSessionAssigned: async (id) => other.push(id),
    }),
  ).rejects.toThrow("timed out");
  expect(other).toEqual([preassignedId()]);
});

// Ownership of an unconfirmed pre-assigned id (issue #395). A session file is written in a fake
// Claude config directory, in the shape that Claude Code 2.1.292 writes.
async function withSessionStore(files, body) {
  const config = await mkdtemp(join(tmpdir(), "claude-config-"));
  const work = await realpath(await mkdtemp(join(tmpdir(), "claude-work-")));
  try {
    for (const { project, id, cwd } of files(work)) {
      await mkdir(join(config, "projects", project), { recursive: true });
      const lines = [
        { type: "queue-operation", sessionId: id },
        { type: "user", cwd, sessionId: id },
      ];
      await writeFile(
        join(config, "projects", project, `${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join("\n"),
      );
    }
    vi.stubEnv("CLAUDE_CONFIG_DIR", config);
    await body(work);
  } finally {
    vi.unstubAllEnvs();
    await rm(config, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
}

const unconfirmed = (id) => ({
  kind: "claude",
  sessionId: id,
  sessionUnconfirmed: true,
  model: null,
  effort: null,
});

// Usefulness: verifies an unconfirmed id with no session file is refused before any CLI starts and
// is marked missing, so the runtime reruns the turn as a first turn with its preamble (issue #395).
test("claude refuses to resume an unconfirmed id with no session file", async () => {
  vi.mocked(exec).mockClear();
  await withSessionStore(
    () => [],
    async (work) => {
      const state = unconfirmed("11111111-1111-4111-8111-111111111111");
      const caught = await runClaude(state, "p", { cwd: work }).catch((e) => e);
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

// Usefulness: verifies an unconfirmed id whose session belongs to another work tree is never
// resumed, because an unrelated session can hold the same UUID (issue #395).
test("claude refuses to resume an unconfirmed id whose session belongs to another work tree", async () => {
  vi.mocked(exec).mockClear();
  const id = "22222222-2222-4222-8222-222222222222";
  await withSessionStore(
    () => [{ project: "-elsewhere", id, cwd: "/somewhere/else" }],
    async (work) => {
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work }).catch((e) => e);
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

// Usefulness: verifies an unconfirmed id whose session file records this work tree is resumed, and
// that a successful turn confirms it (issue #395).
test("claude resumes an unconfirmed id that this work tree owns and confirms it", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  await withSessionStore(
    (work) => [{ project: "-any-encoding", id, cwd: work }],
    async (work) => {
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: JSON.stringify({ session_id: id, result: "ok" }),
        stderr: "",
      });
      const state = unconfirmed(id);
      await expect(runClaude(state, "p", { cwd: work })).resolves.toBe("ok");
      expect(vi.mocked(exec).mock.calls.at(-1)[1]).toEqual(
        expect.arrayContaining(["--resume", id]),
      );
      expect(state.sessionUnconfirmed).toBeUndefined();
    },
  );
});

// Usefulness: verifies the unconfirmed mark follows what the CLI reported: set on a first turn,
// kept after a failure that printed no id, and cleared by a reported id or a success (issue #395).
test("claude marks a pre-assigned id unconfirmed until the CLI reports the session", async () => {
  const fresh = () => ({ kind: "claude", sessionId: null, model: null, effort: null });

  const killed = fresh();
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude timed out."), { stdout: "", stderr: "", timedOut: true }),
  );
  await runClaude(killed, "p", { cwd: "/path" }).catch(() => {});
  expect(killed.sessionUnconfirmed).toBe(true);

  const reported = fresh();
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("claude exited with code 1."), {
      stdout: JSON.stringify({ type: "result", session_id: "s-reported", result: "boom" }),
      stderr: "",
    }),
  );
  await runClaude(reported, "p", { cwd: "/path" }).catch(() => {});
  expect(reported.sessionId).toBe("s-reported");
  expect(reported.sessionUnconfirmed).toBeUndefined();

  const done = fresh();
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });
  await runClaude(done, "p", { cwd: "/path" });
  expect(done.sessionUnconfirmed).toBeUndefined();
});
