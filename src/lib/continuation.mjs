import { readFile } from "node:fs/promises";
import { normalizeAgent } from "../agents/index.mjs";
import { readableErrorText } from "./error-message.mjs";
import { ROLE_KINDS } from "./args.mjs";
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

const isChildInvocation = (event) =>
  event?.type === "invocation" && (event.role === "worker" || event.role === "reviewer");

/**
 * The `gate` event a headless run appends as its last event when it returns an
 * exit code (#393). It counts the child results and the child invocations
 * (worker and reviewer) in `events`, so a continuation can tell that the events
 * it reads are the events the run wrote. A run that ends on a thrown error
 * (SIGINT, a fatal turn, a detected mutation) appends none.
 * @param {object[]} events
 * @returns {{ type: "gate", results: number, childInvocations: number }}
 */
export function gateRecord(events) {
  return {
    type: "gate",
    results: events.filter((event) => event?.type === "result").length,
    childInvocations: events.filter(isChildInvocation).length,
  };
}

/**
 * Derives the gate state of the earlier run from its transcript events (#393). No
 * stored flag is read: each value comes from the result events. Returns null,
 * which keeps the reset, unless all of these hold:
 * - the last event is a `gate` record, so a transcript with no record, and a run
 *   that ended on a thrown error or kept running after the record, reset;
 * - the record's counts equal the child results and child invocations before it,
 *   so a deleted or added event resets;
 * - no child invocation follows the last result, so a turn that started and
 *   returned no result (canceled, failed) resets;
 * - the last result is a reviewer turn that ended `ok` with a string response and
 *   a reviewed state.
 * `acceptedSinceWorker` is the accept rule applied to that turn. `workerRan` is
 * true when a worker result event exists or the earlier run was itself
 * continued, which can only tighten a gate. Any unexpected value gives null, never
 * a throw. Does not check the work tree; `matchingGate` does.
 * @param {{ events?: object[], options?: { continueFrom?: string } } | null | undefined} earlier
 * @returns {object | null}
 */
export function gateFromTranscript(earlier) {
  try {
    const events = earlier?.events;
    if (!Array.isArray(events) || events.at(-1)?.type !== "gate") return null;
    const before = events.slice(0, -1);
    const expected = gateRecord(before);
    const record = events.at(-1);
    if (
      record.results !== expected.results ||
      record.childInvocations !== expected.childInvocations
    ) {
      return null;
    }
    const lastIndex = before.findLastIndex((event) => event?.type === "result");
    const last = before[lastIndex];
    if (
      lastIndex < 0 ||
      before.slice(lastIndex + 1).some(isChildInvocation) ||
      last.role !== "reviewer" ||
      last.result?.status !== "ok" ||
      typeof last.result.response !== "string" ||
      !last.result.reviewed
    ) {
      return null;
    }
    return {
      workerRan:
        Boolean(earlier.options?.continueFrom) ||
        before.some((event) => event?.type === "result" && event.role === "worker"),
      reviewerRan: true,
      reviewerTurnDispatched: true,
      acceptedSinceWorker: isAcceptedReview(last.result.response),
      lastReviewed: last.result.reviewed,
    };
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
