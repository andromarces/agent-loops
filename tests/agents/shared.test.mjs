import { expect, test } from "vite-plus/test";
import {
  boundedDetail,
  lastClosingMessage,
  setMainLoopUsage,
  setUsageOrDelete,
  singleSessionId,
  turnExecOptions,
} from "../../src/agents/shared.mjs";

// Usefulness: pins the presence rules every adapter relies on, so a refactor of the shared setter cannot change what a turn records.
test("setUsageOrDelete stores a reported value and deletes the field when none was reported", () => {
  const state = { usage: { mainLoop: { stale: true } } };

  setUsageOrDelete(state, { totalCostUsd: 1 });
  expect(state.usage).toEqual({ totalCostUsd: 1 });

  setUsageOrDelete(state, undefined);
  expect("usage" in state).toBe(false);

  state.usage = { stale: true };
  setUsageOrDelete(state, null);
  expect("usage" in state).toBe(false);
});

// Usefulness: a reported empty object is real usage, while absent or null must not leave a stale value behind.
test("setMainLoopUsage keeps an empty object and deletes on absent or null usage", () => {
  const state = {};

  setMainLoopUsage(state, {});
  expect(state.usage).toEqual({ mainLoop: {} });

  setMainLoopUsage(state, undefined);
  expect("usage" in state).toBe(false);

  state.usage = { mainLoop: { stale: true } };
  setMainLoopUsage(state, null);
  expect("usage" in state).toBe(false);
});

// Usefulness: pins the one failure-detail bound both adapters use (issue #1407): the flattened
// text, ellipsis included, never exceeds the limit, and shorter text keeps its single line.
test("boundedDetail flattens to one line and counts the ellipsis inside the limit", () => {
  const limit = 10;

  expect(boundedDetail("line one\n  line two", limit)).toBe("line on...");
  expect(boundedDetail("line one\n  line two", limit)).toHaveLength(limit);
  expect(boundedDetail("short\n text", limit)).toBe("short text");
});

// Usefulness: verifies the bound holds below the ellipsis length too (issue #1407), so a small
// limit cannot produce output longer than the limit it names.
test("boundedDetail never exceeds a limit shorter than the ellipsis", () => {
  expect(boundedDetail("abcd", 3)).toBe("...");
  expect(boundedDetail("abcd", 2)).toBe("..");
  expect(boundedDetail("abcd", 1)).toBe(".");
  expect(boundedDetail("abcd", 0)).toBe("");

  for (const limit of [0, 1, 2, 3, 4, 5]) {
    expect(boundedDetail("abcdef", limit).length).toBeLessThanOrEqual(limit);
  }
});

const CLOSING = "Conclusion: c.\nWhy: w.\nBlockers: none";

// Usefulness: pins the selection rule the Codex and Copilot adapters share (issue #449): the last message that holds a closing block attempt wins, parseable or not, and a turn with none keeps the last message.
test("lastClosingMessage picks the last message with a closing block attempt, else the last message", () => {
  const first = `a\n${CLOSING}`;
  const second = `b\n${CLOSING.replace("c.", "later")}`;

  expect(lastClosingMessage([first, "late"])).toBe(first);
  expect(lastClosingMessage([first, second, "late"])).toBe(second);
  expect(lastClosingMessage([first, "Conclusion: only"])).toBe("Conclusion: only");
  expect(lastClosingMessage([first, "Blockers:\n- x"])).toBe("Blockers:\n- x");
  expect(lastClosingMessage([first, "**Verdict**: reject"])).toBe("**Verdict**: reject");
  expect(lastClosingMessage([first, "The conclusion is none yet."])).toBe(first);
  expect(lastClosingMessage(["x", "y"])).toBe("y");
});

// Usefulness: pins the exec options every adapter passes for a turn, so an absent env or spawn hook never reaches `exec` as an explicit undefined that changes its behavior.
test("turnExecOptions maps turn options to exec options and omits an absent env and spawn hook", () => {
  const onTurnChild = () => {};
  const signal = new AbortController().signal;
  const env = { A: "1" };

  expect(
    turnExecOptions(
      { cwd: "/dir", timeout: 5, signal, role: "worker", env, onTurnChild },
      "prompt",
    ),
  ).toEqual({
    cwd: "/dir",
    input: "prompt",
    timeout: 5,
    signal,
    role: "worker",
    env,
    onSpawn: onTurnChild,
  });

  const bare = turnExecOptions({ cwd: "/dir" }, "prompt");
  expect("env" in bare).toBe(false);
  expect("onSpawn" in bare).toBe(false);
  expect(bare.input).toBe("prompt");
});

// Usefulness: verifies one valid id repeated across values resolves, so the three adapters keep
// their shared evidence rule.
test("singleSessionId returns the one id every value names", () => {
  expect(singleSessionId(["sess-1", "sess-1"])).toBe("sess-1");
});

// Usefulness: verifies no evidence, a missing value, a malformed value, and two ids never resolve,
// so an adapter cannot guess a session.
test("singleSessionId refuses no id, an invalid id, and two ids", () => {
  expect(singleSessionId([])).toBeUndefined();
  expect(singleSessionId(["sess-1", undefined])).toBeUndefined();
  expect(singleSessionId([undefined])).toBeUndefined();
  expect(singleSessionId(["sess-1", null])).toBeUndefined();
  expect(singleSessionId([7, 7])).toBeUndefined();
  expect(singleSessionId(["sess-1", "sess-2"])).toBeUndefined();
});
