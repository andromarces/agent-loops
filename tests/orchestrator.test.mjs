import { expect, test, vi } from "vite-plus/test";
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

// Usefulness: verifies requirement "a run_worker, run_reviewer, or abort with an unknown key is
// refused" (#1034): the action goes through the repair turn, which names the key, instead of
// running with the key dropped.
test.each([
  ['{"action": "run_worker", "prompt": "build it", "promt": "typo"}', "run_worker"],
  ['{"action": "run_reviewer", "prompt": "check it", "promt": "typo"}', "run_reviewer"],
  ['{"action": "abort", "reason": "stop", "promt": "typo"}', "abort"],
])("decide repairs %s", async (bad, action) => {
  const good = { run_worker: "build it", run_reviewer: "check it", abort: "stop" }[action];
  const field = action === "abort" ? "reason" : "prompt";
  const prompts = [];
  const agent = fakeAgent([
    (_state, prompt) => {
      prompts.push(prompt);
      return bad;
    },
    (_state, prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ action, [field]: good });
    },
  ]);
  const result = await decide({
    agent,
    state: { kind: "fake", sessionId: "sess-1" },
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(result).toEqual({ action, [field]: good });
  expect(prompts[1]).toContain('"promt"');
});

// Usefulness: verifies requirement "the headless finish refuses an unknown key" (#1021): the action
// goes through the repair turn instead of finishing with the key dropped.
test("decide repairs a finish that carries an unknown key", async () => {
  const summary = '"changed": "a", "verified": "b", "deferred": "c", "notDone": "d", "open": "e"';
  const agent = fakeAgent([
    `{"action": "finish", "summary": {${summary}}, "unresolved_compare": true}`,
    `{"action": "finish", "summary": {${summary}}, "unresolvedCompare": true}`,
  ]);
  const action = await decide({
    agent,
    state: { kind: "fake", sessionId: "sess-1" },
    prompt: "initial",
    options: { cwd: process.cwd() },
  });

  expect(action.unresolvedCompare).toBe(true);
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

// Usefulness: verifies decide never passes a sandbox input and keeps readOnly true on the first
// and the repair turn, so a reviewer-only sandbox opt-in cannot reach the orchestrator (issue #421).
test("decide passes readOnly true and no sandbox input on the first and repair turn", async () => {
  const seen = [];
  const agent = fakeAgent([
    (_state, _prompt, options) => (seen.push(options), "not json"),
    (_state, _prompt, options) => (seen.push(options), '{"action": "abort", "reason": "stop"}'),
  ]);
  await decide({
    agent,
    state: { kind: "fake", sessionId: "s" },
    prompt: "initial",
    options: { cwd: "/dir", sandbox: "workspace-write", reviewerSandbox: "workspace-write" },
  });

  expect(seen).toHaveLength(2);
  for (const options of seen) {
    expect(options.readOnly).toBe(true);
    expect(options).not.toHaveProperty("sandbox");
    expect(options).not.toHaveProperty("reviewerSandbox");
  }
});
