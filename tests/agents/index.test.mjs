import { expect, test, vi } from "vite-plus/test";
import { defaultAgents, runAgent } from "../../src/agents/index.mjs";
import { exec } from "../../src/lib/exec.mjs";

// Only `exec` is replaced: the Codex turn directory removal runs its helper through `execBounded`.
vi.mock("../../src/lib/exec.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  exec: vi.fn(),
}));

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

// Requirement (#587): a cancel that lands after the child exits and before the adapter returns ends
// the turn as canceled for every adapter. Not redundant: the opencode test covers only its own adapter.
for (const [kind, stdout] of Object.entries(CLEAN_OUTPUT)) {
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

// Requirement (#587): a turn with no abort still returns its response. Guards the check against a
// false cancel.
test("a turn with an unaborted signal returns its response", async () => {
  vi.mocked(exec).mockResolvedValueOnce({ stdout: CLEAN_OUTPUT.agy, stderr: "" });

  await expect(
    runAgent({ kind: "agy", sessionId: null }, "task", {
      cwd: "/path",
      signal: new AbortController().signal,
    }),
  ).resolves.toBe("done");
});

// Requirement (#587, #577, ADR 0027): a canceled turn that ran in a replaced agy conversation keeps
// the id the CLI reported and the replaced mark, so the next worker turn sends the preamble to it.
// Not redundant: the adapter test covers the replacement, not the cancel that follows it.
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
