import { expect, test, vi } from "vite-plus/test";
import { runAgent } from "../../src/agents/index.mjs";
import { exec } from "../../src/lib/exec.mjs";

vi.mock("../../src/lib/exec.mjs", () => ({
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

// Requirement (#587, #577): a canceled turn that ran in a replaced agy conversation keeps the id the
// role had, so the next resume replaces the conversation again and sends the worker preamble. Not
// redundant: the adapter test covers the replacement, not the cancel that follows it.
test("a cancel after agy replaced the conversation keeps the earlier id and no replaced mark", async () => {
  const controller = new AbortController();
  vi.mocked(exec).mockImplementationOnce(async () => {
    controller.abort();
    return { stdout: CLEAN_OUTPUT.agy, stderr: "" };
  });
  const state = { kind: "agy", sessionId: "earlier-conversation" };

  await expect(
    runAgent(state, "task", { cwd: "/path", signal: controller.signal }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(state.sessionId).toBe("earlier-conversation");
  expect(state.conversationReplaced).toBeUndefined();
});
