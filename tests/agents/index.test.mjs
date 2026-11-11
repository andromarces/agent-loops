import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { defaultAgents, runAgent } from "../../src/agents/index.mjs";
import { exec } from "../../src/lib/exec.mjs";

// `exec` is replaced by the cases. The turn directory removal is answered in this process, so no
// `turn-tmpdir-remove.mjs` child starts per turn.
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const { turnTmpdirRemovalDouble } = await import("../turn-tmpdir-removal-helpers.mjs");
  return {
    ...actual,
    exec: vi.fn(),
    execBounded: turnTmpdirRemovalDouble(actual.execBounded),
  };
});

const SESSION = "11111111-1111-4111-8111-111111111111";

// The output of a clean turn for each adapter, as its `exec` returns it.
const CLEAN_OUTPUT = {
  claude: JSON.stringify({ session_id: SESSION, result: "done" }),
  codex: [
    JSON.stringify({ type: "thread.started", thread_id: SESSION }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
  ].join("\n"),
  copilot: [
    JSON.stringify({ type: "assistant.message", data: { content: "done" } }),
    JSON.stringify({ type: "result", sessionId: SESSION }),
  ].join("\n"),
  agy: JSON.stringify({ conversation_id: SESSION, response: "done" }),
};

for (const [kind, stdout] of Object.entries(CLEAN_OUTPUT)) {
  // Requirement: a cancel that lands after the child exits and before the adapter returns ends the
  // turn as canceled for every adapter (issue #587). Not redundant: the opencode test covers only
  // its own adapter.
  test(`${kind} ends a turn as canceled when the signal aborts after the child exits`, async () => {
    const controller = new AbortController();
    vi.mocked(exec).mockImplementationOnce(async () => {
      controller.abort();
      return { stdout, stderr: "" };
    });

    await expect(
      runAgent({ kind, sessionId: null }, "task", { cwd: "/path", signal: controller.signal }),
    ).rejects.toMatchObject({ isCanceled: true });
  });
}

// Requirement: a turn with no abort still returns its response (issue #587). Guards the check
// against a false cancel.
test("a turn with an unaborted signal returns its response", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: CLEAN_OUTPUT.agy, stderr: "" });

  await expect(
    runAgent({ kind: "agy", sessionId: null }, "task", {
      cwd: "/path",
      signal: new AbortController().signal,
    }),
  ).resolves.toBe("done");
});

// Requirement: a canceled turn that ran in a replaced agy conversation keeps the id the CLI
// reported and the replaced mark, so the next worker turn sends the preamble to it (issues #587,
// #577, ADR 0027). Not redundant: the adapter test covers the replacement, not the cancel.
test("a cancel after agy replaced the conversation keeps the reported id and the replaced mark", async () => {
  const controller = new AbortController();
  vi.mocked(exec).mockImplementationOnce(async () => {
    controller.abort();
    return { stdout: CLEAN_OUTPUT.agy, stderr: "" };
  });
  const state = { kind: "agy", sessionId: "earlier-conversation" };

  await expect(
    runAgent(state, "task", { cwd: "/path", signal: controller.signal }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(state.sessionId).toBe(SESSION);
  expect(state.conversationReplaced).toBe(true);
});

// Usefulness: verifies requirement "the other four adapters keep their arguments in every reviewer
// sandbox mode" (ADR 0038): only the Codex adapter reads the reviewer `sandbox` input, so a changed
// argv here would apply a mode to a CLI that has none. A resumed session avoids the random id.
test.each(["claude", "agy", "copilot", "opencode"])(
  "%s passes identical arguments whatever the reviewer sandbox input",
  async (kind) => {
    const argvFor = async (sandbox) => {
      vi.mocked(exec).mockReset();
      vi.mocked(exec).mockResolvedValue({ stdout: "", stderr: "" });
      const state = { kind, sessionId: "sess-1", model: null, effort: null };
      // The empty reply fails the parse of the adapter, which is not under test: the argv is.
      await defaultAgents[kind]
        .run(state, "p", { cwd: "/dir", readOnly: true, ...(sandbox ? { sandbox } : {}) })
        .catch(() => {});
      expect(vi.mocked(exec)).toHaveBeenCalled();
      const [command, args, options] = vi.mocked(exec).mock.calls[0];
      return { command, args, env: options?.env };
    };

    const baseline = await argvFor(undefined);
    for (const sandbox of ["none", "read-only", "workspace-write"]) {
      expect(await argvFor(sandbox)).toEqual(baseline);
    }
  },
);

// The output of a clean turn for each of the four adapters, opencode included.
const OK_OUTPUT = {
  ...CLEAN_OUTPUT,
  opencode: JSON.stringify({ type: "text", sessionID: SESSION, part: { text: "done" } }),
};

// Usefulness: verifies every adapter passes the worker role to the central spawn, which sets the pnpm dependency check to warn (issue #1385). An adapter that drops the role leaves pnpm on install.
test.each(["claude", "codex", "copilot", "agy", "opencode"])(
  "%s passes the worker role to its spawn",
  async (kind) => {
    vi.mocked(exec).mockResolvedValueOnce({ stdout: OK_OUTPUT[kind], stderr: "" });
    const before = vi.mocked(exec).mock.calls.length;
    await runAgent({ kind, sessionId: null }, "task", { cwd: "/path", role: "worker" });
    expect(vi.mocked(exec).mock.calls[before][2]?.role).toBe("worker");
  },
);

// Requirement (#1178, ADR 0068): a Claude, agy, Copilot, or opencode turn runs with a private
// temporary directory, so a file that the CLI writes through `TMPDIR` never lands in the inherited
// directory, and the runtime removes the private one on a clean turn and on a failed one. Not
// redundant: the Codex tests cover only the Codex adapter.
describe.each(["claude", "agy", "copilot", "opencode"])(
  "%s private turn temporary directory",
  (kind) => {
    const inherited = () => resolve(tmpdir());

    /** Runs one turn whose mocked CLI writes a file through `TMPDIR`, and reports what it saw. */
    async function turnWriting(ok) {
      const seen = {};
      vi.mocked(exec).mockImplementationOnce(async (_command, _args, options) => {
        const env = options?.env ?? {};
        Object.assign(seen, { TMPDIR: env.TMPDIR, TEMP: env.TEMP, TMP: env.TMP });
        seen.file = join(env.TMPDIR ?? inherited(), `scratch-${kind}.out`);
        await writeFile(seen.file, "scratch");
        seen.during = await readdir(env.TMPDIR ?? inherited());
        if (!ok) throw Object.assign(new Error("boom"), { stdout: "", stderr: "" });
        return { stdout: OK_OUTPUT[kind], stderr: "" };
      });
      const state = { kind, sessionId: null };
      const outcome = await runAgent(state, "task", { cwd: "/path", role: "worker" }).then(
        () => "ok",
        () => "error",
      );
      return { seen, outcome };
    }

    // Requirement: a private temporary directory keeps the scratch file of a turn out of the
    // inherited directory, and the runtime removes it on a clean and a failed turn (issue #1178,
    // ADR 0068).
    test.each([true, false])(
      "keeps the scratch file of a turn (ok: %s) out of the inherited directory",
      async (ok) => {
        const { seen, outcome } = await turnWriting(ok);
        try {
          expect(outcome).toBe(ok ? "ok" : "error");
          expect(seen.TMPDIR).toBeTypeOf("string");
          expect([seen.TEMP, seen.TMP]).toEqual([seen.TMPDIR, seen.TMPDIR]);
          expect(dirname(seen.TMPDIR)).toBe(inherited());
          expect(seen.during).toContain(`scratch-${kind}.out`);
          expect(await readdir(inherited())).not.toContain(`scratch-${kind}.out`);
          await expect(stat(seen.TMPDIR)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await rm(seen.file ?? "", { force: true });
        }
      },
    );
  },
);
