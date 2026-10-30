import { isDeepStrictEqual } from "node:util";
import { isFullSha } from "./git-sha.mjs";
import { isJsonObject } from "./json.mjs";
import { isAcceptedReview } from "./report.mjs";
import { reviewedState, snapshot } from "./snapshot.mjs";

const GATE_FLAGS = ["workerRan", "reviewerRan", "reviewerTurnDispatched", "acceptedSinceWorker"];
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
    !(isFullSha(reviewed.head) || reviewed.head === "unborn") ||
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
