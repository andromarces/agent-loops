import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runClaude } from "../../src/agents/claude.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { verifyResolvedModels } from "../../src/lib/continuation.mjs";
import { runChild } from "../../src/runtime.mjs";

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
      input: expect.stringMatching(/^test prompt\n\n\[agent-loop session [0-9a-f-]{36} role \]$/),
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
      await expect(runClaude(state, "p", { cwd: work, role: "worker" })).rejects.toThrow(
        "timed out",
      );
      const kept = state.sessionId;
      // The CLI saved the session of the killed turn.
      const config = process.env.CLAUDE_CONFIG_DIR;
      await mkdir(join(config, "projects", "-p"), { recursive: true });
      await writeFile(
        join(config, "projects", "-p", `${kept}.jsonl`),
        JSON.stringify({
          type: "user",
          cwd: work,
          sessionId: kept,
          message: { role: "user", content: `p\n\n${marker(kept, "worker")}` },
        }),
      );

      vi.mocked(exec).mockResolvedValueOnce({
        stdout: JSON.stringify({ session_id: kept, result: "ok" }),
        stderr: "",
      });
      await expect(runClaude(state, "again", { cwd: work, role: "worker" })).resolves.toBe("ok");
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
      await expect(runClaude(state, "p", { cwd: work, role: "worker" })).rejects.toThrow(
        "timed out",
      );
      const kept = state.sessionId;

      const caught = await runClaude(state, "again", { cwd: work, role: "worker" }).catch((e) => e);
      expect(caught.sessionMissing).toBe(true);

      state.sessionId = null;
      vi.mocked(exec).mockResolvedValueOnce({
        stdout: JSON.stringify({ session_id: "s-new", result: "ok" }),
        stderr: "",
      });
      await runClaude(state, "again", { cwd: work, role: "worker" });
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
    return [
      cmd,
      args.filter((_, i) => i !== at && i !== at + 1),
      { ...opts, input: opts.input.replace(/[0-9a-f-]{36}/, "<id>") },
    ];
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

// The line that the adapter appends to the prompt of a first turn (issue #395).
const marker = (id, role) => `[agent-loop session ${id} role ${role}]`;

// Ownership of an unconfirmed pre-assigned id (issue #395). A session file is written in a fake
// Claude config directory, in the shape that Claude Code 2.1.292 writes.
async function withSessionStore(files, body) {
  const config = await mkdtemp(join(tmpdir(), "claude-config-"));
  const work = await realpath(await mkdtemp(join(tmpdir(), "claude-work-")));
  try {
    for (const { project, id, cwd, role = "worker", content } of files(work)) {
      await mkdir(join(config, "projects", project), { recursive: true });
      const lines = [
        { type: "queue-operation", sessionId: id },
        {
          type: "user",
          cwd,
          sessionId: id,
          message: { role: "user", content: content ?? `task\n\n${marker(id, role)}` },
        },
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
      const caught = await runClaude(state, "p", { cwd: work, role: "worker" }).catch((e) => e);
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
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work, role: "worker" }).catch(
        (e) => e,
      );
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
      await expect(runClaude(state, "p", { cwd: work, role: "worker" })).resolves.toBe("ok");
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

// Usefulness: verifies the first prompt of a first turn carries the marker for the pre-assigned id
// and the role, the one thing the ownership check later requires in the first user record
// (issue #395).
test("claude appends the session marker to the prompt of a first turn only", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });
  const state = { kind: "claude", sessionId: null, model: null, effort: null };
  await runClaude(state, "do it", { cwd: "/path", role: "worker" });
  const input = vi.mocked(exec).mock.calls.at(-1)[2].input;
  expect(input).toBe(`do it\n\n${marker(preassignedId(), "worker")}`);

  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok" }),
    stderr: "",
  });
  await runClaude(state, "again", { cwd: "/path", role: "worker" });
  expect(vi.mocked(exec).mock.calls.at(-1)[2].input).toBe("again");
});

// Usefulness: verifies a session of this work tree that the adapter did not start for this id and
// role is never resumed: an unrelated session can share the UUID and the work tree (issue #395).
test.each([
  ["no marker", () => ({ content: "an unrelated task" })],
  ["the marker of another role", (id) => ({ role: "reviewer", id })],
  [
    "the marker of another id",
    () => ({ content: marker("44444444-4444-4444-8444-444444444444", "worker") }),
  ],
])("claude refuses to resume an unconfirmed id whose first prompt has %s", async (_n, make) => {
  vi.mocked(exec).mockClear();
  const id = "55555555-5555-4555-8555-555555555555";
  await withSessionStore(
    (work) => [{ project: "-p", id, cwd: work, ...make(id) }],
    async (work) => {
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work, role: "worker" }).catch(
        (e) => e,
      );
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

// Usefulness: verifies an id that is not a canonical UUID is refused before any filesystem path is
// built from it, so a path fragment cannot reach a file outside the projects directory (issue #395).
test.each([
  ["a parent path", "../outside"],
  ["a nested path", "a/b"],
  ["an uppercase UUID", "55555555-5555-4555-8555-55555555555A"],
  ["an empty-looking id", " "],
])("claude refuses an unconfirmed id that is %s without reading a file", async (_n, id) => {
  vi.mocked(exec).mockClear();
  await withSessionStore(
    (work) => [{ project: "-p", id: "55555555-5555-4555-8555-555555555555", cwd: work }],
    async (work) => {
      // A valid session file sits where the traversal would land.
      const config = process.env.CLAUDE_CONFIG_DIR;
      await writeFile(
        join(config, "projects", "outside.jsonl"),
        JSON.stringify({
          type: "user",
          cwd: work,
          sessionId: "../outside",
          message: { content: marker("../outside", "worker") },
        }),
      );
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work, role: "worker" }).catch(
        (e) => e,
      );
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

// Usefulness: verifies a symlinked project directory or session file is never followed out of the
// projects directory, and that only a regular file counts (issue #395).
test.each([
  ["a symlinked project directory", "dir"],
  ["a symlinked session file", "file"],
])("claude refuses an unconfirmed id behind %s", async (_n, kind, ctx) => {
  vi.mocked(exec).mockClear();
  const id = "66666666-6666-4666-8666-666666666666";
  await withSessionStore(
    (work) => [{ project: "-real", id, cwd: work }],
    async (work) => {
      const config = process.env.CLAUDE_CONFIG_DIR;
      const projects = join(config, "projects");
      try {
        if (kind === "dir") {
          // The valid session lives outside the projects directory, behind a symlinked project.
          await rename(join(projects, "-real"), join(config, "elsewhere"));
          await symlink(join(config, "elsewhere"), join(projects, "-real"), "dir");
        } else {
          await mkdir(join(config, "elsewhere"));
          await rename(
            join(projects, "-real", `${id}.jsonl`),
            join(config, "elsewhere", `${id}.jsonl`),
          );
          await symlink(
            join(config, "elsewhere", `${id}.jsonl`),
            join(projects, "-real", `${id}.jsonl`),
            "file",
          );
        }
      } catch (err) {
        if (err?.code === "EPERM") ctx.skip();
        throw err;
      }
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work, role: "worker" }).catch(
        (e) => e,
      );
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

// Usefulness: verifies a directory named like the session file is not a regular file (issue #395).
test("claude refuses an unconfirmed id whose session path is a directory", async () => {
  vi.mocked(exec).mockClear();
  const id = "77777777-7777-4777-8777-777777777777";
  await withSessionStore(
    () => [],
    async (work) => {
      const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", "-p", `${id}.jsonl`);
      await mkdir(dir, { recursive: true });
      const caught = await runClaude(unconfirmed(id), "p", { cwd: work, role: "worker" }).catch(
        (e) => e,
      );
      expect(caught.sessionMissing).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    },
  );
});

const resolved = async (result, state = { kind: "claude", sessionId: null, model: null }) => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ session_id: "s1", result: "ok", ...result }),
    stderr: "",
  });
  await runClaude(state, "p", { cwd: "/path" });
  return state.resolvedModel;
};

// Usefulness: --continue-from compares the model Claude Code resolved, so a result that names
// exactly one well-formed model in `modelUsage` records it.
test("claude records the one model its result reports as resolvedModel", async () => {
  expect(await resolved({ modelUsage: { "claude-opus-5-5": { inputTokens: 1 } } })).toBe(
    "claude-opus-5-5",
  );
});

// Usefulness: a false resolved model would refuse or pass a continuation wrongly, so several
// models (a subagent or helper ran), and every malformed `modelUsage` shape, mark the turn
// unresolved (null), which differs from "not reported" (the field absent).
test.each([
  ["several models", { modelUsage: { a: {}, b: {} } }],
  ["no modelUsage", {}],
  ["an empty object", { modelUsage: {} }],
  ["a string, whose characters are not keys", { modelUsage: "x" }],
  ["an array, whose indexes are not keys", { modelUsage: [{ inputTokens: 1 }] }],
  ["a null", { modelUsage: null }],
  ["a non-object entry", { modelUsage: { "claude-opus-5-5": 7 } }],
  ["a blank key", { modelUsage: { " ": {} } }],
  ["a key with whitespace", { modelUsage: { "claude opus": {} } }],
])("claude marks the turn unresolved for %s", async (_label, result) => {
  expect(await resolved(result)).toBeNull();
});

// Usefulness: the record describes the latest turn, so a turn with unreadable or ambiguous evidence
// replaces an earlier model with unresolved (null) instead of leaving a stale model that a later
// --continue-from would compare against (a false refusal of an unchanged model, or a false pass).
test.each([
  ["no modelUsage", {}],
  ["several models", { modelUsage: { a: {}, b: {} } }],
  ["a malformed modelUsage", { modelUsage: "x" }],
])("claude replaces the earlier resolvedModel with unresolved for %s", async (_label, result) => {
  const state = { kind: "claude", sessionId: null, model: null, resolvedModel: "claude-opus-5-5" };
  expect(await resolved(result, state)).toBeNull();
});

test("claude replaces the earlier resolvedModel when a turn names another single model", async () => {
  const state = { kind: "claude", sessionId: null, model: null, resolvedModel: "claude-opus-5-5" };
  expect(await resolved({ modelUsage: { "claude-opus-5-6": {} } }, state)).toBe("claude-opus-5-6");
});

// A failure as `exec` throws it: an ExecError that carries the output the child printed.
const execFailure = (overrides = {}) =>
  Object.assign(new Error("claude exited with code 1."), {
    name: "ExecError",
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    isCanceled: false,
    isTerminated: false,
    ...overrides,
  });

const failedState = () => ({
  kind: "claude",
  sessionId: null,
  model: null,
  resolvedModel: "claude-opus-5-5",
});

// Usefulness: the session ran on the model a failed turn names, so the record must follow it. Probe from
// review: a failed turn named B while the record kept A, so a probe of B refused and a probe of A passed.
test("claude records the model a failed turn names, replacing the earlier one", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({
      stdout: JSON.stringify({ session_id: "s1", modelUsage: { "claude-opus-5-6": {} } }),
    }),
  );
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("exited");
  expect(state.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: a turn that ran and named no single model may have run on another model, so the record
// becomes unresolved, on every failure path that writes the transcript: a non-zero exit with no or
// ambiguous output, a timeout, a cancel, a signal, and an exit 0 with output that does not parse.
test.each([
  ["a non-zero exit with no output", execFailure()],
  [
    "a non-zero exit with several models",
    execFailure({ stdout: JSON.stringify({ modelUsage: { a: {}, b: {} } }) }),
  ],
  ["a non-zero exit with output that is not JSON", execFailure({ stdout: "oops" })],
  ["a timeout", execFailure({ timedOut: true })],
  ["a cancel", execFailure({ isCanceled: true })],
  ["a signal", execFailure({ isTerminated: true, exitCode: undefined })],
])("claude marks the record unresolved after %s", async (_label, failure) => {
  vi.mocked(exec).mockRejectedValueOnce(failure);
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

test("claude marks the record unresolved after an exit 0 whose output does not parse", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: "not json", stderr: "" });
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: the record describes the session the role keeps. A session that cannot be established
// from the output (no session_id) may have run on any model, so the record is unresolved even when the
// output names one.
test("claude marks the record unresolved when the output names no session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({
    stdout: JSON.stringify({ result: "ok", modelUsage: { "claude-opus-5-6": {} } }),
    stderr: "",
  });
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("session_id");
  expect(state.resolvedModel).toBeNull();
});

const namingB = (sessionId) => ({
  session_id: sessionId,
  result: "ok",
  modelUsage: { "claude-opus-5-6": {} },
});

// Usefulness: reported outcome. A resumed turn whose output is another session naming B keeps the
// original session id, so the record must not become B (a continuation would refuse A and accept B
// against the session the role keeps). The record is unresolved, so a continuation compares nothing.
test("claude does not record the model of a session the role does not keep", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-other")), stderr: "" });
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow("did not resume");
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();

  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const now of ["claude-opus-5-5", "claude-opus-5-6"]) {
      const roles = {
        orchestrator: { kind: "codex", model: null, effort: null, resolvedModel: undefined },
        worker: { ...state, resolvedModel: state.resolvedModel },
        reviewer: { kind: "agy", model: null, effort: null, resolvedModel: undefined },
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

// Usefulness: a resumed turn that reports the retained session records its model, and a first turn
// records the session it adopts.
test("claude records the model of the retained or adopted session", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-kept")), stderr: "" });
  const resumed = { ...failedState(), sessionId: "s-kept" };
  await runClaude(resumed, "p", { cwd: "/path" });
  expect(resumed.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockResolvedValueOnce({ stdout: JSON.stringify(namingB("s-new")), stderr: "" });
  const first = failedState();
  await runClaude(first, "p", { cwd: "/path" });
  expect(first.sessionId).toBe("s-new");
  expect(first.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: the same session rule holds on a failed turn: only evidence of the kept session records,
// and a failed output with no session, or another one, is unresolved.
test.each([
  ["the retained session", "s-kept", "claude-opus-5-6"],
  ["another session", "s-other", null],
  ["no session", undefined, null],
])("claude failed turn that reports %s", async (_label, reported, expected) => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify({ ...namingB(reported) }) }),
  );
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBe(expected);
});

test("claude failed first turn records the model only with the session it adopts", async () => {
  vi.mocked(exec).mockRejectedValueOnce(execFailure({ stdout: JSON.stringify(namingB("s-new")) }));
  const adopted = failedState();
  await expect(runClaude(adopted, "p", { cwd: "/path" })).rejects.toThrow();
  expect(adopted.sessionId).toBe("s-new");
  expect(adopted.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify(namingB(undefined)) }),
  );
  const none = failedState();
  await expect(runClaude(none, "p", { cwd: "/path" })).rejects.toThrow();
  // The pre-assigned id stays when the output names no session (#395), and its model is unknown.
  expect(none.sessionId).toBe(preassignedId());
  expect(none.resolvedModel).toBeNull();
});

// Usefulness: a process that never started ran no model, so the record stays: a spawn failure leaves
// the earlier state, and the earlier session is unchanged.
test("claude leaves the record alone when the process never started", async () => {
  vi.mocked(exec).mockRejectedValueOnce(execFailure({ exitCode: undefined }));
  const state = failedState();
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBe("claude-opus-5-5");
});

// Usefulness: a resume of a missing session ran no model turn, but the rerun as a first turn does: the
// record follows the rerun, and a rerun that fails too leaves it unresolved, never the stale model.
test("claude record follows the rerun after a missing session", async () => {
  vi.mocked(exec)
    .mockRejectedValueOnce(missingFailure({ name: "ExecError", timedOut: false }))
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        session_id: "s2",
        result: "ok",
        modelUsage: { "claude-opus-5-6": {} },
      }),
      stderr: "",
    });
  const state = { ...failedState(), sessionId: "gone" };
  const outcome = await runChild({ role: state, roleName: "worker", prompt: "t", cwd: "/path" });
  expect(outcome.status).toBe("ok");
  expect(state.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec)
    .mockRejectedValueOnce(missingFailure({ name: "ExecError", timedOut: false }))
    .mockRejectedValueOnce(execFailure());
  const again = { ...failedState(), sessionId: "gone" };
  const failed = await runChild({ role: again, roleName: "worker", prompt: "t", cwd: "/path" });
  expect(failed.status).toBe("error");
  expect(again.resolvedModel).toBeNull();
});

const eventsOf = (...events) => ({ stdout: JSON.stringify(events), stderr: "" });
const systemEvent = (session_id) => ({ type: "system", subtype: "init", session_id });
const resultEvent = (session_id, models = { "claude-opus-5-6": {} }) => ({
  type: "result",
  ...(session_id === undefined ? {} : { session_id }),
  result: "ok",
  modelUsage: models,
});

// Usefulness: one consistent source. With an array of events, the model counts only when the event that
// carries it also names the session, and every event of the output names that one session. Reported
// fixture: a system event names the retained session while the result event with `modelUsage` names
// another, so the old selection kept session s-kept with the model of s-other.
test.each([
  ["a result event of another session", [systemEvent("s-kept"), resultEvent("s-other")]],
  ["a result event with no session", [systemEvent("s-kept"), resultEvent(undefined)]],
  ["a later event of another session", [resultEvent("s-kept"), systemEvent("s-other")]],
  ["a malformed session on one event", [resultEvent("s-kept"), { type: "x", session_id: 7 }]],
  [
    "two result events that disagree on the model",
    [resultEvent("s-kept"), resultEvent("s-kept", { "claude-opus-5-5": {} })],
  ],
])("claude records unresolved for %s in an array of events", async (_label, events) => {
  vi.mocked(exec).mockResolvedValueOnce(eventsOf(...events));
  const state = { ...failedState(), sessionId: "s-kept" };
  await runClaude(state, "p", { cwd: "/path" }).catch(() => {});
  expect(state.sessionId).toBe("s-kept");
  expect(state.resolvedModel).toBeNull();
});

// Usefulness: a normal single-session array still records the model of its result event.
test("claude records the model of a single-session array of events", async () => {
  vi.mocked(exec).mockResolvedValueOnce(eventsOf(systemEvent("s-kept"), resultEvent("s-kept")));
  const state = { ...failedState(), sessionId: "s-kept" };
  await runClaude(state, "p", { cwd: "/path" });
  expect(state.resolvedModel).toBe("claude-opus-5-6");

  vi.mocked(exec).mockResolvedValueOnce(
    eventsOf(
      systemEvent("s-new"),
      resultEvent("s-new", { "claude-opus-5-6": {} }),
      resultEvent("s-new", { "claude-opus-5-6": {} }),
    ),
  );
  const first = failedState();
  await runClaude(first, "p", { cwd: "/path" });
  expect(first.sessionId).toBe("s-new");
  expect(first.resolvedModel).toBe("claude-opus-5-6");
});

// Usefulness: the same single-source rule holds on a failed turn.
test("claude failed turn with mixed sessions in an array records unresolved", async () => {
  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify([systemEvent("s-kept"), resultEvent("s-other")]) }),
  );
  const state = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(state, "p", { cwd: "/path" })).rejects.toThrow();
  expect(state.resolvedModel).toBeNull();

  vi.mocked(exec).mockRejectedValueOnce(
    execFailure({ stdout: JSON.stringify([systemEvent("s-kept"), resultEvent("s-kept")]) }),
  );
  const same = { ...failedState(), sessionId: "s-kept" };
  await expect(runClaude(same, "p", { cwd: "/path" })).rejects.toThrow();
  expect(same.resolvedModel).toBe("claude-opus-5-6");
});
