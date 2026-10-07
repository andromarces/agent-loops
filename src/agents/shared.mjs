import { hasClosingBlockAttempt } from "../lib/report.mjs";

/**
 * Sets `state.usage` to `usage`, or removes it when the CLI reported none (`undefined` or
 * `null`), so a turn that omits usage leaves no stale value behind. An empty object is kept.
 */
export function setUsageOrDelete(state, usage) {
  if (usage == null) {
    delete state.usage;
  } else {
    state.usage = usage;
  }
}

/**
 * Sets `state.usage.mainLoop` from one turn's usage, or removes `state.usage` when
 * the CLI reported none.
 * Any truthy value counts as usage; a caller with a narrower rule passes a filtered value.
 */
export function setMainLoopUsage(state, usage) {
  setUsageOrDelete(state, usage ? { mainLoop: usage } : undefined);
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
 * and its edits instead of starting a new one. An id already on the state is never replaced
 * here, so a failed turn never changes a resumed session.
 */
export function keepFailedSessionId(state, id) {
  if (!state.sessionId && typeof id === "string" && id) {
    state.sessionId = id;
  }
}

/**
 * Marks a failed resume whose session the CLI does not have, so the runtime can rerun the turn
 * as a first turn. The mark is narrow because a wrong mark reruns a real failure and can repeat
 * its edits: the process must exit 1 without a timeout, cancel, or signal, stdout must be the
 * empty string, and stderr must be the one line the CLI prints for the requested id, byte for
 * byte, followed by at most one line ending (LF or CRLF). That single line ending is the only
 * normalization. Leading or trailing spaces, blank lines, a second line, other text, or another
 * id leave the error unmarked.
 * Nothing is marked for a first turn, which has no session to lose.
 * @param {unknown} err the error `exec` threw
 * @param {string | null} requestedId session id the failed call asked the CLI to resume
 * @param {(id: string) => string} missingLine the CLI's stderr line for a missing session
 */
export function flagMissingSession(err, requestedId, missingLine) {
  if (requestedId && failedWithLine(err, missingLine(requestedId))) {
    err.sessionMissing = true;
  }
}

/**
 * True when a failed call exited 1 without a timeout, cancel, or signal, printed nothing on stdout,
 * and printed exactly `line` on stderr, followed by at most one line ending (LF or CRLF).
 * @param {unknown} err the error `exec` threw
 * @param {string} line the one stderr line to match, byte for byte
 */
export function failedWithLine(err, line) {
  if (!err || typeof err !== "object") {
    return false;
  }
  const exited = err.exitCode === 1 && !err.timedOut && !err.isCanceled && !err.isTerminated;
  const stderr = typeof err.stderr === "string" ? err.stderr.replace(/\r?\n$/, "") : null;
  return exited && err.stdout === "" && stderr === line;
}

/**
 * Returns `value` when it is a non-empty string, else `undefined`. A CLI id of any other type,
 * such as a number or an object, is not a session id, so a success path must not store it.
 */
export function asSessionId(value) {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Returns the message of a turn that carries the closing block the parent reads: the last
 * message that holds a closing block attempt, so a late answer to an event after the block does
 * not replace the report of the turn (issue #449). An attempt counts whether or not it parses,
 * so a later malformed block still wins and reaches the caller as `raw`, and an earlier block
 * never overrides it. When no message holds an attempt, the last message is returned.
 * @param {string[]} messages assistant messages of one turn, in order and non-empty
 */
export function lastClosingMessage(messages) {
  return messages.findLast(hasClosingBlockAttempt) ?? messages.at(-1);
}
