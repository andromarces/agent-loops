import { hasClosingBlockAttempt } from "../lib/report.mjs";

// A model id has no whitespace or control character, so a sentence or a blank is not one.
const MODEL_ID = /^[^\s\p{Cc}]+$/u;

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

/**
 * Sets `state.resolvedModel` to the resolution state of the turn that just succeeded, one of three:
 * - a model id: the output named one model, from well-formed, unambiguous evidence (at least one
 *   value, every value a model id, which is a non-empty string with no whitespace or control
 *   character, and all values equal);
 * - `null`, unresolved: the output was unreadable, malformed, or ambiguous (several models, no
 *   model, a value of another type). An earlier model is replaced, because it describes an earlier
 *   turn, and `--continue-from` compares nothing against it;
 * - the field absent, not reported: the adapter never calls this, as for a CLI that reports no model.
 * The record describes the session the role keeps. An adapter calls `recordResolvedModel`, which calls
 * this, for every turn whose child process ran, failed or not, because a turn that ran may have run the
 * session on another model. It does not call it when `childRan` is false.
 * @param {object} state role state; mutated
 * @param {unknown[]} reported the model values the turn output named, malformed ones included
 */
export function setResolvedModel(state, reported) {
  const [first] = reported;
  const named =
    typeof first === "string" && MODEL_ID.test(first) && reported.every((m) => m === first);
  state.resolvedModel = named ? first : null;
}

/**
 * False only when `exec` reports that the child process never started (POSIX: no exit code and no
 * timeout, cancel, or signal), so the turn ran no model and the resolved-model record stays. Every
 * other failure, including an error of an unknown shape, counts as a turn that ran, so the record
 * is set from what the output shows, or to unresolved, and never keeps a model the session may have left.
 * @param {unknown} err the error `exec` threw
 */
export function childRan(err) {
  if (!err || typeof err !== "object" || err.name !== "ExecError") return true;
  return !(err.exitCode == null && !err.timedOut && !err.isCanceled && !err.isTerminated);
}

/**
 * Records the resolution state of a turn that ran, for the session the role keeps after it. The model
 * evidence counts only when the output's session is that session: the retained id, or the new id that a
 * first turn adopts. An output that reports another session than the retained one (the case
 * `resumeMismatchError` catches), or no valid session, cannot be tied to the kept session, which may
 * have run on any model, so the record is unresolved (`null`). Call it before any check that throws,
 * on the success and the failure path alike.
 * @param {object} state role state; mutated
 * @param {unknown[]} reported the model values the output named
 * @param {string | null} requestedId the session id the turn asked the CLI to resume, or null
 * @param {unknown} returnedId the session id the output reports
 */
export function recordResolvedModel(state, reported, requestedId, returnedId) {
  const session = asSessionId(returnedId);
  const keptSession = Boolean(session) && (!requestedId || session === requestedId);
  setResolvedModel(state, keptSession ? reported : []);
}

/**
 * Throws the cancel error (`isCanceled`) when `signal` is aborted, for a turn whose adapter already
 * returned. A turn that ran in a replaced conversation never received the role preamble or
 * instructions, and a canceled turn cannot send them. `replacedFrom`, the id the turn resumed, then
 * goes back on `state`, so the next resume replaces the conversation again and sends them (ADR 0027).
 * Pass it only when the conversation was replaced.
 * @param {AbortSignal | undefined} signal
 * @param {string} name the name in the error message
 * @param {object} state role state; mutated on a cancel
 * @param {string | null} [replacedFrom]
 */
export function throwIfCanceled(signal, name, state, replacedFrom) {
  if (!signal?.aborted) return;
  if (replacedFrom !== undefined) state.sessionId = replacedFrom;
  delete state.conversationReplaced;
  throw Object.assign(new Error(`${name} was canceled.`), { isCanceled: true });
}
