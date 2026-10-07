import { readFile } from "node:fs/promises";
import { normalizeAgent } from "../agents/index.mjs";
import { readableErrorText } from "./error-message.mjs";
import { ROLE_KINDS } from "./args.mjs";
import { isDeepStrictEqual } from "node:util";
import { isAcceptedReview } from "./report.mjs";
import { reviewedState, snapshot } from "./snapshot.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). Rejects a file that is
 * unreadable, not JSON, has `events` that are not a list, or is missing a role
 * with a string `kind` and a string or null `sessionId`.
 * @param {string} path
 * @returns {Promise<{ cwd: string, roles: object, events?: object[] }>}
 */
export async function readContinuation(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--continue-from cannot read ${path}: ${readableErrorText(err)}`);
  }
  let transcript;
  try {
    transcript = JSON.parse(text);
  } catch {
    throw new Error(`--continue-from ${path} is not valid JSON.`);
  }
  if (!transcript?.roles || typeof transcript.roles !== "object") {
    throw new Error(`--continue-from ${path} has no roles, so it is not an agent-loop transcript.`);
  }
  if (transcript.events !== undefined && !Array.isArray(transcript.events)) {
    throw new Error(`--continue-from ${path} has events that are not a list.`);
  }
  for (const role of ROLE_KINDS) {
    const earlier = transcript.roles[role];
    if (
      typeof earlier?.kind !== "string" ||
      (earlier.sessionId !== null && typeof earlier.sessionId !== "string")
    ) {
      throw new Error(`--continue-from ${path} has an invalid ${role} role.`);
    }
  }
  return transcript;
}

/**
 * Copies the earlier session ids onto the new roles after checking that each
 * session can resume: the role kind, the recorded model, the recorded effort, and
 * the work tree must equal the earlier run's, because a session id is valid only
 * for the CLI that created it and a provider keeps a session per project
 * directory. One rule covers every adapter: model and effort compare exactly, so
 * an omitted value matches only an omitted value. known-limit: an omitted model
 * runs the CLI's own default, and a change of that default between the two runs
 * is not detected, because the transcript records what the caller requested.
 * Changes no role when it throws. A role that never ran keeps a null id and
 * starts a new session.
 * @param {object} roles new run roles keyed by role name; mutated on success
 * @param {{ cwd: string, roles: object }} earlier
 * @param {string} cwd
 */
export function restoreSessions(roles, earlier, cwd) {
  if (earlier.cwd !== cwd) {
    throw new Error(
      `--continue-from: the earlier run used --cwd ${earlier.cwd}, not ${cwd}. A session resumes only in the work tree that created it.`,
    );
  }
  for (const role of ROLE_KINDS) {
    const before = earlier.roles[role];
    const now = roles[role];
    if (normalizeAgent(before.kind) !== normalizeAgent(now.kind)) {
      throw new Error(
        `--continue-from: ${role} was ${before.kind} in the earlier run, not ${now.kind}. A session id is valid only for the CLI that created it.`,
      );
    }
    for (const field of ["model", "effort"]) {
      if ((before[field] ?? null) !== (now[field] ?? null)) {
        throw new Error(
          `--continue-from: ${role} ${field} was ${describe(before[field])} in the earlier run, not ${describe(now[field])}.`,
        );
      }
    }
  }
  for (const role of ROLE_KINDS) {
    roles[role].sessionId = earlier.roles[role].sessionId;
  }
}

function describe(value) {
  return value ? JSON.stringify(value) : "(omitted)";
}

const GATE_FLAGS = ["workerRan", "reviewerRan", "reviewerTurnDispatched", "acceptedSinceWorker"];
const HEAD_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64}|unborn)$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The gate state of a run that starts with no earlier run (#234). */
export const freshGate = () => ({
  workerRan: false,
  reviewerRan: false,
  reviewerTurnDispatched: false,
  acceptedSinceWorker: false,
  lastReviewed: null,
});

/** The gate state of a continued run that restores nothing (#362): the tree counts as unreviewed. */
export const resetGate = () => ({ ...freshGate(), workerRan: true });

/**
 * The gate transition for one child result. `runLoop` and the replay in
 * `gateFromTranscript` both apply it, so the two cannot drift apart. A worker
 * turn clears the accept. A reviewer turn sets `reviewerRan` when it ended `ok`,
 * and sets or clears the accept from its verdict and Checks line. Every turn
 * replaces the reviewed state with the one it carries, or none.
 * @param {object} state a gate state; not mutated
 * @param {"worker" | "reviewer"} role
 * @param {{ status: string, response?: string, reviewed?: object }} result
 * @returns {object} the next gate state
 */
export function applyResult(state, role, result) {
  const lastReviewed = result.reviewed ?? null;
  if (role === "worker") {
    return { ...state, workerRan: true, acceptedSinceWorker: false, lastReviewed };
  }
  const ok = result.status === "ok";
  return {
    ...state,
    reviewerTurnDispatched: true,
    reviewerRan: state.reviewerRan || ok,
    acceptedSinceWorker: ok && isAcceptedReview(result.response),
    lastReviewed,
  };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A reviewed state as the runtime snapshot writes it. Its values get a stricter
// check in `matchingGate`, against the current snapshot.
const isReviewedShape = (value) =>
  isObject(value) &&
  typeof value.clean === "boolean" &&
  typeof value.exact === "boolean" &&
  typeof value.head === "string" &&
  typeof value.digest === "string";

// One result event as `runLoop` emits it: a worker or reviewer role, and the
// fields of that role's `ok` or `error` result.
function isValidResultEvent(event) {
  const { result } = event;
  if ((event.role !== "worker" && event.role !== "reviewer") || !isObject(result)) return false;
  if (result.reviewed !== undefined && !isReviewedShape(result.reviewed)) return false;
  if (result.status === "ok") return typeof result.response === "string";
  return result.status === "error" && typeof result.error === "string";
}

/**
 * Rebuilds the gate state of the earlier run by replaying its transcript events in
 * file order through the transitions `runLoop` applies (#393). No stored flag is
 * trusted. Returns the replayed state, or null, which keeps the reset, unless all
 * of these hold:
 * - every event is an object with a string `type`, and every `invocation` and
 *   `result` event is well formed (role exactly `orchestrator`, `worker`, or
 *   `reviewer`; for a result, the fields of its `ok` or `error` shape);
 * - no worker or reviewer invocation is left without a result, so a canceled or
 *   failed turn resets;
 * - the last event is the `gate` event a run that returned an exit code appends,
 *   so a transcript with none, and a run that ended on a thrown error, reset;
 * - the replayed state equals that record, so a deleted, added, or reordered event
 *   that changes the state resets.
 * A `continued` event restarts the replay at the reset state. A transcript of a
 * continued run with no such event starts at the reset state too. Does not check
 * the work tree; `matchingGate` does. Any unexpected value gives null, never a
 * throw. known-limit: a well-formed event sequence that replays to the recorded
 * state is accepted, because the transcript carries no signature.
 * @param {{ events?: object[], options?: { continueFrom?: string } } | null | undefined} earlier
 * @returns {object | null}
 */
export function gateFromTranscript(earlier) {
  try {
    const events = earlier?.events;
    const record = Array.isArray(events) ? events.at(-1) : null;
    if (record?.type !== "gate") return null;
    const continuedEvents = events.some((event) => event?.type === "continued");
    let state = earlier.options?.continueFrom && !continuedEvents ? resetGate() : freshGate();
    let childOpen = false;
    for (const event of events.slice(0, -1)) {
      if (!isObject(event) || typeof event.type !== "string") return null;
      if (event.type === "continued") {
        state = resetGate();
        childOpen = false;
      } else if (event.type === "invocation") {
        if (!["orchestrator", "worker", "reviewer"].includes(event.role)) return null;
        if (event.status !== "ok" && event.status !== "error") return null;
        childOpen ||= event.role !== "orchestrator";
      } else if (event.type === "result") {
        if (!isValidResultEvent(event)) return null;
        state = applyResult(state, event.role, event.result);
        childOpen = false;
      }
    }
    const recorded = Object.keys(state).every((key) => isDeepStrictEqual(record[key], state[key]));
    return childOpen || !recorded ? null : state;
  } catch {
    return null;
  }
}

/**
 * Returns the gate state to restore, or null to keep the reset. The state
 * restores only when the record is well formed (strict booleans, a Git head or
 * `unborn`, a SHA-256 digest, `exact` true) and the current snapshot is exact with
 * the same head and digest as `lastReviewed`. The restored `lastReviewed` is the
 * current runtime state, so `clean` and `exact` never come from the record. A
 * snapshot that cannot be read gives null: the reset costs only a reviewer turn.
 * @param {object | null | undefined} earlierGate from `gateFromTranscript`
 * @param {string} cwd
 * @returns {Promise<{ workerRan: boolean, reviewerRan: boolean, reviewerTurnDispatched: boolean, acceptedSinceWorker: boolean, lastReviewed: object } | null>}
 */
export async function matchingGate(earlierGate, cwd) {
  const reviewed = earlierGate?.lastReviewed;
  if (
    GATE_FLAGS.some((flag) => typeof earlierGate?.[flag] !== "boolean") ||
    typeof reviewed?.clean !== "boolean" ||
    reviewed.exact !== true ||
    typeof reviewed.head !== "string" ||
    typeof reviewed.digest !== "string" ||
    !HEAD_PATTERN.test(reviewed.head) ||
    !DIGEST_PATTERN.test(reviewed.digest)
  ) {
    return null;
  }
  let current;
  try {
    current = reviewedState(await snapshot(cwd));
  } catch {
    return null;
  }
  if (!current.exact || current.head !== reviewed.head || current.digest !== reviewed.digest) {
    return null;
  }
  return {
    ...Object.fromEntries(GATE_FLAGS.map((flag) => [flag, earlierGate[flag]])),
    lastReviewed: current,
  };
}

/**
 * Appends the earlier run's events to `events`, then one `continued` event that
 * keeps the earlier outcome a same-path transcript rewrite replaces. A loop, not
 * an argument spread: a spread over a long event list throws RangeError, and the
 * list has no bound.
 * @param {object[]} events destination; mutated
 * @param {{ events?: object[], exitCode?: number, error?: string | null, options?: { maxSteps?: number } }} earlier
 */
export function carryEarlierEvents(events, earlier) {
  for (const event of earlier.events ?? []) {
    events.push(event);
  }
  events.push({
    type: "continued",
    earlier: {
      exitCode: earlier.exitCode ?? null,
      error: earlier.error ?? null,
      maxSteps: earlier.options?.maxSteps ?? null,
    },
    at: new Date().toISOString(),
  });
}
