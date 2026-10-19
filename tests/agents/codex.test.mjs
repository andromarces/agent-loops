import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { runCodex } from "../../src/agents/codex.mjs";
import { exec } from "../../src/lib/exec.mjs";
import { parseReportBlock, parseVerdict } from "../../src/lib/report.mjs";
import { exists, removePath, symlinkOrSkip } from "../runtime-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
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
    expect.objectContaining({ cwd: "/dir", input: "prompt text" }),
  );
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
    expect.objectContaining({ cwd: "/dir", input: "resume prompt" }),
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
    Object.assign(new Error("codex exited with code 1."), { stdout, stderr: "" }),
  );

  const state = { kind: "codex", sessionId: null, model: null, effort: null };
  await expect(runCodex(state, "p", { cwd: "/dir" })).rejects.toThrow("exited");
  expect(state.sessionId).toBe("th-failed");
});

// Usefulness: verifies a failed resumed turn never changes the stored id.
test("codex keeps the stored thread id when a resumed turn fails", async () => {
  const stdout = JSON.stringify({ type: "thread.started", thread_id: "th-other" });
  vi.mocked(exec).mockRejectedValueOnce(
    Object.assign(new Error("codex exited with code 1."), { stdout, stderr: "" }),
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

// Usefulness: verifies the reviewer sandbox input "none" runs the Codex turn with no sandbox in the
// same `-c` form on new and resumed sessions (ADR 0038), and that an explicit "read-only" input
// keeps the present read-only invocation. Both are cheap to break and none is covered above.
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
      ...tail,
    ]);
    expect(await run("read-only")).toEqual([...head, "-c", 'sandbox_mode="read-only"', ...tail]);
  },
);

const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];
const OK_EVENTS = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "item.completed", item: { type: "agent_message", text: "done" } },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

// Points the inherited temporary directory at `root` for `run`, then restores it.
async function withInheritedTmp(root, run) {
  const saved = TMP_VARS.map((name) => process.env[name]);
  for (const name of TMP_VARS) process.env[name] = root;
  try {
    return await run();
  } finally {
    TMP_VARS.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
}

// Stands in for the Codex CLI: it creates two empty `.tmpXXXXXX` directories in the temporary
// directory that it inherits, as the real CLI does on every `exec` turn, then runs `after`.
function fakeCodex(after) {
  const seen = {};
  vi.mocked(exec).mockImplementationOnce(async (_cmd, _args, options) => {
    const env = options.env ?? {};
    seen.env = env;
    const home = env.TMPDIR ?? process.env.TMPDIR;
    seen.home = home;
    await mkdir(join(home, ".tmpAbC123"));
    await mkdir(join(home, ".tmpXyZ789"));
    return after ? after(home) : { stdout: OK_EVENTS, stderr: "" };
  });
  return seen;
}

const runTurn = (options = {}) =>
  runCodex({ kind: "codex", sessionId: null, model: null, effort: null }, "p", {
    cwd: "/dir",
    ...options,
  });

// Usefulness: verifies acceptance #955 — a Codex turn leaves no new entry in the inherited
// temporary directory, because the CLI gets a private per-turn one that the runtime removes.
test.each([
  ["reviewer", { readOnly: true, sandbox: "none", role: "reviewer" }],
  ["worker", { role: "worker" }],
  ["orchestrator", { readOnly: true, role: "orchestrator" }],
])("a codex %s turn leaves nothing in the inherited temporary directory", async (_name, opts) => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const seen = fakeCodex();
    await withInheritedTmp(root, () => runTurn(opts));
    expect(await readdir(root)).toEqual([]);
    expect(seen.home).not.toBe(root);
    for (const name of TMP_VARS) expect(seen.env[name]).toBe(seen.home);
    expect(basename(seen.home).length).toBeLessThanOrEqual(12);
  } finally {
    await removePath(root);
  }
});

// Usefulness: verifies the cleanup also runs when the CLI fails, times out, or is canceled, so
// no failure path leaks the private directory.
test.each([
  ["a failure", {}],
  ["a timeout", { timedOut: true }],
  ["a cancel", { isCanceled: true }],
])("a codex turn that ends with %s still removes its temporary directory", async (_n, flags) => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    fakeCodex(async () => {
      throw Object.assign(new Error("codex failed"), flags);
    });
    await expect(withInheritedTmp(root, () => runTurn())).rejects.toThrow("codex failed");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await removePath(root);
  }
});

// Usefulness: verifies a concurrent process keeps its own directory and file in the shared
// temporary directory, so the cleanup touches only the directory that this turn created.
test("a codex turn leaves a concurrent entry in the inherited temporary directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    await mkdir(join(root, ".tmpOther1"));
    await writeFile(join(root, "other.txt"), "keep\n");
    fakeCodex();
    await withInheritedTmp(root, () => runTurn());
    expect((await readdir(root)).sort()).toEqual([".tmpOther1", "other.txt"]);
  } finally {
    await removePath(root);
  }
});

// Usefulness: verifies a user-set temporary directory that is itself a link still works, and the
// private directory lands under its target, so a user who set TMPDIR keeps a working turn.
test("a codex turn works when the user temporary directory is a link", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    await mkdir(join(base, "real"));
    await symlinkOrSkip(ctx, join(base, "real"), join(base, "link"), "junction");
    const seen = fakeCodex();
    await withInheritedTmp(join(base, "link"), () => runTurn());
    expect(seen.home.startsWith(join(base, "link"))).toBe(true);
    expect(await readdir(join(base, "real"))).toEqual([]);
  } finally {
    await removePath(base);
  }
});

// Usefulness: verifies the removal never follows a link that replaces the private directory, so a
// swap during the turn cannot delete content outside it.
test("a codex turn never follows a link at the private directory", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const root = join(base, "root");
    const victim = join(base, "victim");
    await mkdir(root);
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "keep\n");
    fakeCodex(async (home) => {
      await removePath(home);
      await symlinkOrSkip(ctx, victim, home, "junction");
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, () => runTurn());
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  } finally {
    await removePath(base);
  }
});

// Usefulness: verifies the removal never follows a link at a parent component, not only at the
// target, so a swapped temporary root cannot steer the delete into another directory.
test("a codex turn never follows a link at a parent of the private directory", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const root = join(base, "root");
    const victim = join(base, "victim");
    await mkdir(root);
    await mkdir(victim);
    fakeCodex(async (home) => {
      await mkdir(join(victim, basename(home)));
      await writeFile(join(victim, basename(home), "keep.txt"), "keep\n");
      await rename(root, join(base, "moved"));
      await symlinkOrSkip(ctx, victim, root, "junction");
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, () => runTurn());
    expect(await exists(join(victim, "keep.txt"))).toBe(false);
    const [name] = await readdir(victim);
    expect(await exists(join(victim, name, "keep.txt"))).toBe(true);
  } finally {
    await removePath(base);
  }
});
