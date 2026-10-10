import { readFile } from "node:fs/promises";
import { normalizeAgent, REPORTS_RESOLVED_MODEL } from "../agents/index.mjs";
import { logInfo, logWarn } from "./log.mjs";
import { readableErrorText, readProp } from "./error-message.mjs";
import { ROLE_KINDS } from "./args.mjs";
import { isDeepStrictEqual } from "node:util";
import { isAcceptedReview } from "./report.mjs";
import { sha256 } from "./hash.mjs";
import { holdsSession } from "./command-line.mjs";
import { ProcessReadError, readProcessCommands } from "./process-ancestry.mjs";
import { isUuid, readSessionRecord } from "./session-record.mjs";
import { reviewedState, snapshot } from "./snapshot.mjs";

/**
 * Reads the earlier headless run from its `--transcript` file, the only record
 * that holds the final role session ids (#362). A session record that a crashed run left outside the
 * work tree can add the id of one claude first turn (ADR 0027). Rejects a file that is
 * unreadable, not JSON, has `events` that are not a list, or is missing a role
 * with a string `kind`, a string or null `sessionId`, and no `sessionUnconfirmed` or `conversationReplaced`, or a boolean one.
 * @param {string} path
 * @returns {Promise<{ cwd: string, roles: object, events?: object[] }>}
 */
export async function readContinuation(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new Error(`--continue-from cannot read ${path}: ${readableErrorText(err)}`);
  }
  let transcript;
  try {
    transcript = JSON.parse(bytes.toString("utf8"));
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
      (earlier.sessionId !== null && typeof earlier.sessionId !== "string") ||
      (earlier.sessionUnconfirmed !== undefined &&
        typeof earlier.sessionUnconfirmed !== "boolean") ||
      (earlier.conversationReplaced !== undefined &&
        typeof earlier.conversationReplaced !== "boolean")
    ) {
      throw new Error(`--continue-from ${path} has an invalid ${role} role.`);
    }
  }
  await applySessionRecord(path, bytes, transcript);
  return transcript;
}

/**
 * Gives a claude role the pre-assigned id that a crashed run saved outside the work tree. The
 * record is untrusted: it applies only when it binds to this transcript state, work tree, and run, the
 * role is a claude role with no id, and the id stays unconfirmed, so the ownership check of the
 * adapter always runs before the id resumes (ADR 0027).
 */
async function applySessionRecord(path, bytes, transcript) {
  const record = await readSessionRecord(path, {
    digest: sha256(bytes),
    cwd: transcript.cwd,
    runNonce: transcript.runNonce,
  });
  const earlier = record && transcript.roles[record.role];
  if (earlier?.kind === "claude" && earlier.sessionId === null) {
    transcript.roles[record.role] = {
      ...earlier,
      sessionId: record.sessionId,
      sessionUnconfirmed: true,
    };
  }
}

/**
 * Refuses a continuation when another live process names the id of a claude role session in its
 * command line (#647, ADR 0029). A `SIGKILL` of the earlier parent leaves its `claude` child
 * running, and the CLI accepts a resume of that session, so two processes would write one session
 * file. Only a claude id in the UUID form is checked, so a short id cannot match another
 * command line. No other adapter is verified to leave such an orphan. A process table that cannot
 * be read logs a warning and lets the run continue. The read is bounded by `deps.timeout`
 * (seconds) and ends on `deps.signal`. A cancel rejects, so SIGINT still cancels the run.
 * known-limit: the match is by command line, so a holder that does not carry the id as an argument is not found.
 * @param {object} roles roles keyed by role name, after `restoreSessions`
 * @param {{ readProcessCommands?: (options: { signal?: AbortSignal, timeout?: number }) => Promise<{ pid: number, command: string }[]>, signal?: AbortSignal, timeout?: number }} [deps]
 */
export async function refuseHeldSessions(roles, deps = {}) {
  await refuseHeldIds(
    ROLE_KINDS.filter((role) => roles[role].kind === "claude").map((role) => ({
      role,
      sessionId: roles[role].sessionId,
    })),
    { ...deps, label: "--continue-from" },
  );
}

/**
 * The check of `refuseHeldSessions` for a list of `{ role, sessionId }` entries of claude roles.
 * `deps.label` prefixes the warning and the refusal. `deps.platform` (default `process.platform`)
 * selects the command-line rules. Entries whose id is not a UUID are ignored.
 */
export async function refuseHeldIds(entries, deps = {}) {
  const ids = entries
    .filter(({ sessionId }) => isUuid(sessionId))
    .map(({ role, sessionId }) => [role, sessionId]);
  if (ids.length === 0) {
    return;
  }
  const label = deps.label ?? "session check";
  let table;
  try {
    table = await (deps.readProcessCommands ?? readProcessCommands)({
      signal: deps.signal,
      timeout: deps.timeout,
    });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      throw err;
    }
    // Only the reason class of a `ProcessReadError` is printed: the process table holds the command
    // lines of every process on the host.
    logWarn(
      `${label}: cannot check for a live holder of a session: the process table read ${err instanceof ProcessReadError ? err.reason : "failed"}.`,
    );
    return;
  }
  for (const [role, id] of ids) {
    const holder = table.find(
      (entry) =>
        entry.pid !== process.pid &&
        holdsSession(entry.command, id, deps.platform ?? process.platform),
    );
    if (holder) {
      throw new Error(
        `${label}: the ${role} session ${id} is held by process ${holder.pid}, a leftover of an earlier run. End that process, or wait for it to finish, and run again.`,
      );
    }
  }
}

/**
 * Copies the earlier session ids onto the new roles after checking that each
 * session can resume: the role kind, the recorded model, the recorded effort, and
 * the work tree must equal the earlier run's, because a session id is valid only
 * for the CLI that created it and a provider keeps a session per project
 * directory. One rule covers every adapter: model and effort compare exactly, so
 * an omitted value matches only an omitted value. The model each CLI resolved
 * (`resolvedModel`, where its output names one) carries over to the new role;
 * `verifyResolvedModels` compares it with the current default.
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
    // An id that no CLI output confirmed keeps its mark, so the adapter verifies its owner (#395).
    if (earlier.roles[role].sessionUnconfirmed === true && roles[role].sessionId !== null) {
      roles[role].sessionUnconfirmed = true;
    }
    // A canceled turn left a replaced conversation without its preamble, so the new worker turn sends it.
    if (earlier.roles[role].conversationReplaced === true && roles[role].sessionId !== null) {
      roles[role].conversationReplaced = true;
    }
    // A model id or null (unresolved) carries over; an absent or malformed value is "not reported".
    const resolved = earlier.roles[role].resolvedModel;
    if (resolved === null || (typeof resolved === "string" && resolved)) {
      roles[role].resolvedModel = resolved;
    }
  }
}

/**
 * Refuses a continuation when the model a CLI resolves now differs from the one the earlier run
 * recorded in `resolvedModel` (#394, ADR 0026). The transcript holds the requested model, and an
 * omitted model or an alias resolves inside the CLI, so a changed CLI default or alias target is
 * visible only in the output. `resolvedModel` holds the state of the latest turn of the role that
 * ran, failed or not, for the session the role keeps: a model id, `null` (unresolved: that turn named
 * no single model, or its output was not the kept session), or absent (not reported:
 * a CLI that never reports a model, or a record written before this change).
 * Only a recorded model id is compared. For it, `probe` runs one read-only turn in a new session
 * (never the continued one), before any turn of the run, and sets `resolvedModel` on the state it
 * receives. A probe that does not name one model (`null` or absent) skips the comparison with a
 * warning. A recorded `null` skips the probe and the comparison with a warning, and never compares
 * against an older model. An absent record warns for a CLI that can report a model and logs an info
 * line for one that never does. The caller owns the guards of the probe turn (mutation check,
 * cancel), and an error of theirs (`MutationError`, `SnapshotError`, a cancel) is rethrown
 * unchanged. Any other probe failure refuses, because the model is then unverified.
 * known-limit: each probe is a real model call.
 * @param {object} roles new run roles after `restoreSessions`; not mutated
 * @param {{ probe: (state: object, role: string) => Promise<void> }} options
 */
export async function verifyResolvedModels(roles, { probe }) {
  for (const role of ROLE_KINDS) {
    const { kind, model, effort, resolvedModel: recorded } = roles[role];
    if (recorded === null) {
      logWarn(
        `--continue-from: the default-model check did not run for ${role} (${kind}), because the latest turn of the earlier run did not name one model.`,
      );
      continue;
    }
    if (typeof recorded !== "string" || !recorded) {
      if (REPORTS_RESOLVED_MODEL.has(normalizeAgent(kind))) {
        logWarn(
          `--continue-from: the default-model check did not run for ${role} (${kind}), because the earlier record has no resolved model.`,
        );
      } else {
        logInfo(
          `--continue-from: ${role} (${kind}) reports no resolved model, so a changed default model is not detected.`,
        );
      }
      continue;
    }
    const state = { kind, model, effort, sessionId: null };
    logInfo(`--continue-from: probing the model that ${role} (${kind}) resolves now`);
    try {
      await probe(state, role);
    } catch (err) {
      if (
        ["MutationError", "SnapshotError"].includes(readProp(err, "name")) ||
        readProp(err, "isCanceled")
      ) {
        throw err;
      }
      throw new Error(`--continue-from: ${role} model probe failed: ${readableErrorText(err)}`);
    }
    if (typeof state.resolvedModel !== "string" || !state.resolvedModel) {
      logWarn(
        `--continue-from: the default-model check did not run for ${role} (${kind}), because the probe did not name one model.`,
      );
    } else if (state.resolvedModel !== recorded) {
      throw new Error(
        `--continue-from: ${role} resolved to ${JSON.stringify(recorded)} in the earlier run, not ${JSON.stringify(state.resolvedModel)}. The CLI default or alias changed, and a session continues under the model that created it. The model flags must equal the earlier run's, so a new --${role}-model value is refused too. Restore the earlier default in the CLI, or start a new run without --continue-from.`,
      );
    }
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
