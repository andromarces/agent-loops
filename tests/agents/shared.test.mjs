import { expect, test } from "vitest";
import {
  lastClosingMessage,
  setMainLoopUsage,
  setUsageOrDelete,
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
  expect(lastClosingMessage([first, "The conclusion: none yet."])).toBe(first);
  expect(lastClosingMessage(["x", "y"])).toBe("y");
});
