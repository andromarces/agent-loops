import { readFile } from "node:fs/promises";
import { normalizeAgent } from "../agents/index.mjs";
import { readableErrorText } from "./error-message.mjs";
import { ROLE_KINDS } from "./args.mjs";
import { reviewedState, snapshot } from "./snapshot.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). Rejects a file that is
 * unreadable, not JSON, has `events` that are not a list, or is missing a role
 * with a string `kind` and a string or null `sessionId`.
 * @param {string} path
 * @returns {Promise<{ cwd: string, roles: object, gate?: object }>}
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

/**
 * Returns the earlier run's persisted gate state (#393) when the current work
 * tree is the state its last reviewer turn reviewed, otherwise null, which keeps
 * the reset. The state matches only when the persisted `lastReviewed` is an exact
 * snapshot and the current snapshot is exact with the same head and digest. A
 * transcript with no usable gate, or a snapshot that cannot be read, gives null:
 * the reset is always safe, because it only costs a reviewer turn.
 * @param {object | null | undefined} earlierGate the `gate` of the earlier transcript
 * @param {string} cwd
 * @returns {Promise<{ workerRan: boolean, reviewerRan: boolean, reviewerTurnDispatched: boolean, acceptedSinceWorker: boolean, lastReviewed: object } | null>}
 */
export async function matchingGate(earlierGate, cwd) {
  const reviewed = earlierGate?.lastReviewed;
  if (
    !reviewed?.exact ||
    typeof reviewed.head !== "string" ||
    typeof reviewed.digest !== "string" ||
    GATE_FLAGS.some((flag) => typeof earlierGate[flag] !== "boolean")
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
    lastReviewed: reviewed,
  };
}

const GATE_FLAGS = ["workerRan", "reviewerRan", "reviewerTurnDispatched", "acceptedSinceWorker"];

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
