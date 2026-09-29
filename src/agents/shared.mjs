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

/**
 * Keeps the session id a failed first turn reported, so the next turn resumes that session
 * and its edits instead of starting a new one. A turn that resumed an id never changes it.
 */
export function keepFailedSessionId(state, id) {
  if (!state.sessionId && typeof id === "string" && id) {
    state.sessionId = id;
  }
}

/**
 * Marks a failed resume whose session the CLI does not have, so the runtime can rerun the turn
 * as a first turn. The match reads stderr only, because stdout carries model output that could
 * quote the phrase. Nothing is marked for a first turn, which has no session to lose.
 * @param {unknown} err the error `exec` threw
 * @param {string | null} requestedId session id the failed call asked the CLI to resume
 * @param {RegExp} pattern the CLI's stderr text for a session it cannot find
 */
export function flagMissingSession(err, requestedId, pattern) {
  if (requestedId && err && typeof err === "object" && pattern.test(err.stderr ?? "")) {
    err.sessionMissing = true;
  }
}
