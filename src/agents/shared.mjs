/**
 * Sets `state.usage.mainLoop` from one turn's usage, or removes `state.usage` when
 * the CLI reported none, so a turn that omits usage leaves no stale value behind.
 * Any truthy value counts as usage; a caller with a narrower rule passes a filtered value.
 */
export function setMainLoopUsage(state, usage) {
  if (usage) {
    state.usage = { mainLoop: usage };
  } else {
    delete state.usage;
  }
}

/**
 * Builds the error for a resumed CLI that returned a different session id.
 * @param {string} agent display name of the adapter, for example `Codex`
 * @param {string} idLabel name of the id in that CLI, for example `thread` or `session`
 * @param {string} expected session id the caller asked the CLI to resume
 * @param {string} received session id the CLI returned
 */
export function resumeMismatchError(agent, idLabel, expected, received) {
  return new Error(
    [
      `${agent} did not resume the expected ${idLabel}.`,
      `Expected: ${expected}`,
      `Received: ${received}`,
    ].join("\n"),
  );
}
