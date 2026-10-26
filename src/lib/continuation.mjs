import { readFile } from "node:fs/promises";
import { agentHas, normalizeAgent } from "./agent-kinds.mjs";
import { logInfo, logWarn } from "./log.mjs";
import { readableErrorText, readProp } from "./error-message.mjs";
import { REVIEWER_SANDBOX_MODES, ROLE_KINDS, legacyReviewerSandbox } from "./args.mjs";
import { isDeepStrictEqual } from "node:util";
import { isJsonObject } from "./json.mjs";
import { isAcceptedReview } from "./report.mjs";
import { sha256 } from "./hash.mjs";
import { readSessionRecord } from "./session-record.mjs";
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
        typeof earlier.conversationReplaced !== "boolean") ||
      (earlier.taskSentTo !== undefined && typeof earlier.taskSentTo !== "string")
    ) {
      throw new Error(`--continue-from ${path} has an invalid ${role} role.`);
    }
  }
  await applySessionRecord(path, bytes, transcript);
  return transcript;
}

/**
 * The reviewer sandbox mode that the earlier run recorded in the transcript `options`. A transcript
 * from before ADR 0038 has none: it gets `workspace-write` when it holds the legacy
 * `reviewerWorkspaceWrite: true` and `read-only` otherwise, never `none`.
 * @param {{ options?: object }} transcript
 * @param {string} path the transcript path, for the refusal text
 * @returns {"none" | "read-only" | "workspace-write"}
 */
export function earlierReviewerSandbox(transcript, path) {
  const recorded = transcript.options?.reviewerSandbox;
  if (recorded === undefined) {
    return legacyReviewerSandbox(transcript.options?.reviewerWorkspaceWrite);
  }
  if (!REVIEWER_SANDBOX_MODES.includes(recorded)) {
    throw new Error(`--continue-from ${path} has an invalid reviewerSandbox option.`);
  }
  return recorded;
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
    // The task record names a conversation, so it carries over only with the session id it names.
    if (
      roles[role].sessionId !== null &&
      earlier.roles[role].taskSentTo === roles[role].sessionId
    ) {
      roles[role].taskSentTo = roles[role].sessionId;
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
      if (agentHas(normalizeAgent(kind), "reportsResolvedModel")) {
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

// A reviewed state as the runtime snapshot writes it. Its values get a stricter
// check in `matchingGate`, against the current snapshot.
const isReviewedShape = (value) =>
  isJsonObject(value) &&
  typeof value.clean === "boolean" &&
  typeof value.exact === "boolean" &&
  typeof value.head === "string" &&
  typeof value.digest === "string";

// One result event as `runLoop` emits it: a worker or reviewer role, and the
// fields of that role's `ok` or `error` result.
function isValidResultEvent(event) {
  const { result } = event;
  if ((event.role !== "worker" && event.role !== "reviewer") || !isJsonObject(result)) return false;
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
      if (!isJsonObject(event) || typeof event.type !== "string") return null;
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
 * The PR that the runtime declared in the earlier run after a worker turn (ADR 0043), read from
 * its `pr-declared` events. Returns null when the transcript records none. A record that cannot be
 * trusted throws and never reads as no declaration. A null drops the declared-PR finish rule while
 * `gateFromTranscript` still accepts the transcript. These records throw: a `pr` that is not a
 * positive integer, and two events with different PRs. A declared PR that differs from the `--pr`
 * or `--require-ci` of the earlier run throws too. A run that had either flag for the same PR
 * keeps it. known-limit: the transcript carries no signature, as for
 * `gateFromTranscript`, so a removed event is not detected.
 * @param {{ events?: object[], options?: { pr?: number | null, requireCi?: number | null } } | null | undefined} earlier
 * @returns {number | null}
 */
export function declaredPrFromTranscript(earlier) {
  const prs = new Set();
  for (const event of earlier?.events ?? []) {
    if (event?.type !== "pr-declared") continue;
    if (!Number.isSafeInteger(event.pr) || event.pr <= 0) {
      throw new Error(
        `--continue-from has a malformed pr-declared event (pr: ${JSON.stringify(event.pr) ?? "missing"}).`,
      );
    }
    prs.add(event.pr);
  }
  if (prs.size === 0) return null;
  const [declared] = prs;
  const flags = [earlier.options?.pr, earlier.options?.requireCi].filter((n) => n != null);
  if (prs.size > 1 || flags.some((n) => n !== declared)) {
    throw new Error(
      `--continue-from has pr-declared events that disagree with each other or with the --pr and --require-ci of the earlier run (declared: ${[...prs].join(", ")}).`,
    );
  }
  return declared;
}

/**
 * Refuses a `--continue-from` flag that changes or conflicts with the declared PR. The declared PR
 * is an init field of the continued run. A `--pr` or `--require-ci` for another PR is refused, as a
 * changed init field is. A flag for the same PR is accepted. The `review-only` mode refuses a
 * declared PR, as it refuses `--pr` at init. `--compare-head` is refused for any PR, because a
 * declared PR ends through its `--require-ci` gate (#1104).
 * @param {number | null} declaredPr from `declaredPrFromTranscript`
 * @param {{ pr: number | null, requireCi: number | null, mode: string | null, compareHead?: number | null }} options
 */
export function refuseDeclaredPrConflict(declaredPr, { pr, requireCi, mode, compareHead = null }) {
  if (declaredPr === null) return;
  if (compareHead !== null) {
    throw new Error(
      `--compare-head cannot be combined with a continuation of PR ${declaredPr}, which the earlier run declared: that run ends through its --require-ci gate.`,
    );
  }
  for (const [flag, value] of [
    ["--pr", pr],
    ["--require-ci", requireCi],
  ]) {
    if (value !== null && value !== declaredPr) {
      throw new Error(
        `${flag} ${value} cannot change PR ${declaredPr}, which the earlier run declared. Pass ${flag} ${declaredPr}, or omit the flag.`,
      );
    }
  }
  if (mode === "review-only") {
    throw new Error(
      `--mode review-only cannot continue a run that declared PR ${declaredPr}, because that mode refuses a declared PR.`,
    );
  }
}

/**
 * Returns the gate state to restore, or null to keep the reset. The state
 * restores only when the record is well formed (strict booleans, a Git head or
 * `unborn`, a SHA-256 digest, `exact` true) and the current snapshot is exact with
 * the same head and digest as `lastReviewed`. The restored `lastReviewed` is the
 * current runtime state, so `clean` and `exact` never come from the record. A
 * snapshot that cannot be read gives null: the reset costs only a reviewer turn. A cancel through
 * `signal` rejects with the cancel error instead.
 * @param {object | null | undefined} earlierGate from `gateFromTranscript`
 * @param {string} cwd
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ workerRan: boolean, reviewerRan: boolean, reviewerTurnDispatched: boolean, acceptedSinceWorker: boolean, lastReviewed: object } | null>}
 */
export async function matchingGate(earlierGate, cwd, { signal } = {}) {
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
    current = reviewedState(await snapshot(cwd, { signal }));
  } catch (err) {
    // A cancel is not a missing gate, so it reaches the caller as a cancel.
    if (err?.isCanceled) {
      throw err;
    }
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
