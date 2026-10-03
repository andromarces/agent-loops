import { expect, test } from "vitest";
import { setMainLoopUsage, setUsageOrDelete } from "../../src/agents/shared.mjs";

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
