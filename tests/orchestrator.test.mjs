import { expect, test, vi } from "vitest";
import { decide, OrchestratorError } from "../src/orchestrator.mjs";

// Helper to create a fake agent
function fakeAgent(replies) {
  let callIndex = 0;
  return {
    async run(state, prompt, options) {
      const reply = replies[callIndex++];
      if (typeof reply === "function") {
        return reply(state, prompt, options);
      }
      return reply;
    },
  };
}

// Usefulness: verifies valid action without repair is parsed and returned.
test("decide returns valid action on first attempt", async () => {
  const agent = fakeAgent(['{"action": "run_worker", "prompt": "build it"}']);
  const state = { kind: "fake", sessionId: "sess-1" };
  const action = await decide({
    agent,
    state,
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action).toEqual({ action: "run_worker", prompt: "build it" });
});

// Usefulness: verifies fenced JSON is parsed without repair.
test("decide accepts fenced JSON on first attempt", async () => {
  const agent = fakeAgent(['```json\n{"action": "run_reviewer", "prompt": "check it"}\n```']);
  const state = { kind: "fake", sessionId: "sess-1" };
  const action = await decide({
    agent,
    state,
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action).toEqual({ action: "run_reviewer", prompt: "check it" });
});

// Usefulness: verifies unknown fields are pruned from returned action.
test("decide drops unknown fields from action", async () => {
  const agent = fakeAgent(['{"action": "abort", "reason": "stop", "extra": 42}']);
  const state = { kind: "fake", sessionId: "sess-1" };
  const action = await decide({
    agent,
    state,
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action).toEqual({ action: "abort", reason: "stop" });
});

// Usefulness: verifies malformed JSON recovers via one repair turn.
test("decide recovers from malformed response via repair turn", async () => {
  const agent = fakeAgent([
    "Some prose here: {bad json}",
    '{"action": "run_worker", "prompt": "recovered prompt"}',
  ]);
  const state = { kind: "fake", sessionId: "sess-1" };
  const action = await decide({
    agent,
    state,
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action).toEqual({ action: "run_worker", prompt: "recovered prompt" });
});

// Usefulness: verifies failed repair throws OrchestratorError with fatal message.
test("decide throws OrchestratorError when repair turn fails", async () => {
  const agent = fakeAgent(["invalid json 1", "invalid json 2"]);
  const state = { kind: "fake", sessionId: "sess-1" };
  await expect(
    decide({
      agent,
      state,
      prompt: "initial",
      options: { cwd: process.cwd() },
    }),
  ).rejects.toThrow(OrchestratorError);
});

// Usefulness: verifies unsupported action throws OrchestratorError after repair fails.
test("decide throws OrchestratorError when action remains unsupported after repair", async () => {
  const agent = fakeAgent(['{"action": "unsupported_action"}', '{"action": "still_unsupported"}']);
  const state = { kind: "fake", sessionId: "sess-1" };
  await expect(
    decide({
      agent,
      state,
      prompt: "initial",
      options: { cwd: process.cwd() },
    }),
  ).rejects.toThrow(/Orchestrator returned a malformed action after one repair turn/);
});

// Usefulness: verifies issue #26 — a repair turn is unexpected state the code handled, logged at warn.
test("decide logs a warn line when taking a repair turn", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const agent = fakeAgent([
    "Some prose here: {bad json}",
    '{"action": "run_worker", "prompt": "recovered prompt"}',
  ]);
  const state = { kind: "fake", sessionId: "sess-1" };

  const action = await decide({
    agent,
    state,
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action).toEqual({ action: "run_worker", prompt: "recovered prompt" });
  const lines = errorSpy.mock.calls.map((call) => call.join(" "));
  expect(lines.some((line) => line.includes("repair turn"))).toBe(true);
});
