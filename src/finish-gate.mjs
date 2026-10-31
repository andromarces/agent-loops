import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import { compareHeadConflict, missingGateRefusal, unresolvedCompareReason } from "./lib/args.mjs";
import { checkCi, checkPrHead } from "./lib/ci-gate.mjs";
import { logError, logWarn } from "./lib/log.mjs";
import { refusalPrompt } from "./prompts/orchestrator.mjs";

/**
 * Reads one PR gate for a finish. A `gh` failure is a refusal, not a thrown error: the read throws
 * on an unreadable PR, repository, or API reply, and in the interactive path that error leaves the
 * run `active` for the parent to retry. The headless run has no retry outside this refusal, so
 * throwing would discard a run that a later turn could pass. The refusal fails closed either way,
 * and any child turn clears the prior-refusal flag, so a retry costs a step rather than ending the
 * run (#293).
 * @param {object} options
 * @param {() => Promise<{ ok: boolean, reason?: string }>} options.read The gate read.
 * @param {string} options.failedLog Log label for a read that threw.
 * @param {string} options.failedReason Reason prefix for a read that threw.
 * @param {string} options.failedRecovery Recovery text for a read that threw.
 * @param {string} options.refusedRecovery Recovery text for a gate that read and refused.
 * @returns {Promise<{ refusal: { reason: string, recovery: string } | null, result: object | null }>}
 *   `result` is the gate read, or null when the read threw.
 */
async function readGate({ read, failedLog, failedReason, failedRecovery, refusedRecovery }) {
  let result;
  try {
    result = await read();
  } catch (err) {
    // A caller cancel ends the run; it is not a gate refusal that a later turn could pass.
    if (readProp(err, "isCanceled")) throw err;
    const detail = firstErrorLine(readableErrorText(err));
    logError(`${failedLog}: ${detail}`);
    return {
      refusal: { reason: `${failedReason}: ${detail}`, recovery: failedRecovery },
      result: null,
    };
  }
  if (result.ok) return { refusal: null, result };
  return { refusal: { reason: result.reason, recovery: refusedRecovery }, result };
}

/**
 * Evaluates a `finish` action against every applicable gate. Returns `{ stop }`
 * with the loop result when the run ends, or `{ prompt }` with the corrective
 * turn prompt when the first refusal grants one more turn. Emits the
 * `no-required-checks`, `head-compare`, `unresolved-compare`, and `refusal` events.
 *
 * Every applicable refusal is reported in one prompt, in the order of the interactive `role
 * finish`: the unresolved-compare marker, the review-only reviewer-turn condition, the completion
 * rule, the declared-PR condition, then the `requireCi` gate and the `compareHead` compare. A
 * refused finish gets one corrective turn, which costs a step, unless no step budget is left or no
 * child turn has run since the previous refusal. Either case ends the run with exit 1. A refusal
 * for the marker alone recovers with a re-finish and no child turn. The `requireAccept` rule
 * follows turn order only: an edit made outside the loop between the accept and the finish is not
 * detected.
 * @param {object} options
 * @returns {Promise<{ stop: object } | { prompt: string }>}
 */
export async function evaluateFinish({
  action,
  mode,
  requireAccept,
  pr,
  requireCi,
  compareHead,
  compareFlag,
  gate,
  finishRefused,
  stepsUsed,
  maxSteps,
  cwd,
  gh,
  signal,
  onEvent,
  stopLoop,
}) {
  // Every applicable gate is evaluated, and every refusal is reported in one
  // prompt, because the run grants a single corrective turn and a second
  // refused finish ends it. Reporting one condition at a time would spend
  // that turn on a condition the next refusal names instead, which is how a
  // prompt that says "finish again" becomes an exit 1 (#293). The order is
  // the marker condition, the `review-only` reviewer-turn condition, the
  // completion rule, the declared-PR gate condition, then the PR gate. It
  // matches the interactive `role finish` except for the `review-only`
  // condition, which that path cannot reach because its init dispatch is
  // itself a reviewer turn (#337). The
  // `--pr` declaration is the PR input, so its refusal sits where the gate
  // sits (#302).
  const refusals = [];
  // The marker is satisfied by editing the finish action itself, so it is the
  // one refusal that a re-finish can satisfy without a child turn. Every other
  // refusal needs one, and forcing it on the marker would spend a step and
  // start a review cycle the run did not need (#293).
  let needsChildTurn = false;
  // The absence the gate established on a base branch with no required check.
  // It is recorded on the accepted finish only, because another refusal in
  // this same decision means the run did not finish, and a finish that never
  // happened verified nothing (#336 review).
  let noRequiredChecks = false;
  // The marker condition applies to a run that carries the gate and to a run
  // that declares its PR, because both require the gate that resolves the
  // compare. A run that declares neither keeps the marker (#302).
  const markerReason = unresolvedCompareReason({ pr, requireCi });
  if (markerReason !== null && action.unresolvedCompare === true) {
    refusals.push({
      reason: markerReason,
      recovery: "The gate resolves that PR head, so remove unresolvedCompare from the finish.",
    });
  }
  // A review-only run's whole outcome is the reviewer report, so a finish
  // before any reviewer turn is a finish with nothing behind it. The
  // interactive path reaches that state for free, because its init dispatch
  // is itself the reviewer turn, and a headless run owns its whole order, so
  // the runtime refuses it here. The condition is the turn, not its outcome:
  // the interactive finish is accepted after any reviewer turn, including one
  // that ended in a handled error, because the summary records what that turn
  // returned. It sits where `--require-accept` sits, so it takes the same
  // corrective turn and repeated-refusal rule (#337).
  if (mode === "review-only" && !gate.reviewerTurnDispatched) {
    needsChildTurn = true;
    refusals.push({
      reason: "no reviewer turn has run, and a review-only run dispatches no worker",
      recovery:
        "Dispatch the reviewer, then finish once that turn has returned. What the turn returned is what the finish records: the verdict, or the error, goes in verified, and neither blocks the finish.",
    });
  }
  if (requireAccept && (gate.workerRan ? !gate.acceptedSinceWorker : !gate.reviewerRan)) {
    needsChildTurn = true;
    refusals.push({
      reason: gate.workerRan
        ? "no reviewer accept with a Checks line on the latest changed state after a worker turn"
        : "no reviewer report on the state",
      recovery: `Dispatch the reviewer, obtain ${
        gate.workerRan ? "Verdict: accept with a Checks line on that state" : "a reviewer report"
      } on that state, then finish.`,
    });
  }
  // The `--pr` declaration is the run's PR input, so the gate is the only
  // way such a run ends. A declaration with no gate, or with a gate for
  // another PR, refuses the finish: the flag cannot arrive mid-run, so no
  // child turn satisfies it and the run ends on the refusal (#302).
  const missingGate = missingGateRefusal(pr, requireCi);
  if (missingGate) {
    refusals.push(missingGate);
  }
  if (requireCi !== null && !missingGate) {
    // The gate resolves the PR head in the runtime, which is what the parent
    // can no longer misreport. Its own failure is a refusal rather than a
    // thrown error, so a `gh` failure does not discard a run that a later
    // turn could pass (#293).
    const ci = await ciGate({ pr: requireCi, reviewed: gate.lastReviewed, cwd, gh, signal });
    if (ci.refusal) {
      // The gate reads the reviewed state, which only a reviewer turn
      // establishes, so a gate refusal always needs a child turn (#293).
      needsChildTurn = true;
      refusals.push(ci.refusal);
    } else {
      noRequiredChecks = ci.noRequiredChecks;
    }
  }
  if (compareHead !== null) {
    // The compare runs in the runtime, so the parent cannot misreport it. The input has no
    // marker, because the compare either resolved the PR head or refused (#1104).
    const conflict = compareHeadConflict({
      requireCi: null,
      unresolvedCompare: action.unresolvedCompare === true,
      flag: compareFlag,
    });
    // A marker refusal reads nothing from GitHub, as ADR 0051 decision 4 requires, and a re-finish
    // without the marker needs no child turn.
    if (conflict) {
      refusals.push({
        reason: conflict,
        recovery: "The compare resolves that PR head, so remove unresolvedCompare from the finish.",
      });
    }
    const compare = conflict
      ? null
      : await headCompareGate({ pr: compareHead, reviewed: gate.lastReviewed, cwd, gh, signal });
    if (compare) {
      // Like the gate, the compare reads the reviewed state that only a reviewer turn sets.
      needsChildTurn = true;
      refusals.push(compare);
    }
  }
  if (refusals.length === 0) {
    if (compareHead !== null) {
      onEvent({ type: "head-compare", pr: compareHead, stepsUsed });
      return {
        stop: stopLoop(0, {
          summary: action.summary,
          unresolvedCompare: false,
          headCompare: "verified",
        }),
      };
    }
    if (noRequiredChecks) {
      // A base branch with no required check leaves the gate verifying the PR
      // head, the clean reviewed tree, and the merge state only. The event is
      // emitted here, on the accepted finish, so a refused finish never
      // reports an absence for a run that did not finish (#336 review).
      onEvent({ type: "no-required-checks", pr: requireCi, stepsUsed });
    }
    // A finish the parent marks as an unresolved PR-head compare stays on
    // the loop's own recorded-finish code 0, but it emits a
    // machine-readable event and reports the marker, so it never reads the
    // same as a verified finish (#266). The headless process exit code is
    // the CLI's decision: UNRESOLVED_COMPARE_EXIT (#279). The marker stays
    // the only signal for a run without the gate, where the loop has no PR
    // input, so an omitted marker still reads as a verified finish there
    // (#286, #293).
    const unresolvedCompare = action.unresolvedCompare === true;
    if (unresolvedCompare) {
      onEvent({ type: "unresolved-compare", stepsUsed });
    }
    return { stop: stopLoop(0, { summary: action.summary, unresolvedCompare }) };
  }
  // One reason string for the event and the run, listing every condition, so
  // a consumer sees the full set rather than the first one.
  const reason = refusals.map((entry) => entry.reason).join("; ");
  onEvent({ type: "refusal", reason, stepsUsed });
  // A refusal gets one corrective turn. With no step budget left that turn
  // cannot run a child, so the refusal resolves here on the exit-1 path
  // instead of reaching the step-limit exit 2 (#248). A refusal with no child
  // turn since the last one also resolves here, because no other event
  // clears the prior-refusal flag.
  if (finishRefused || stepsUsed >= maxSteps) {
    return { stop: stopLoop(1, { reason: `Finish refused: ${reason}.` }) };
  }
  logWarn(`finish refused: ${reason}`);
  // Two distinct things are described here and need distinct words: any child
  // turn clears the prior-refusal flag, which is not the same as satisfying
  // the condition that refused. The ending states the flag rule, and each
  // recovery states what satisfies its own condition (#293). The missing gate
  // needs its own ending, because a child turn cannot clear it and the
  // marker wording would name a condition the finish does not carry (#302).
  const ending = missingGate
    ? " No child turn clears the missing gate, so this refusal ends the run: a re-finish repeats it, and the run ends on exit 1. Abort with the missing gate named in the reason, or report to the caller that the run needs the gate."
    : needsChildTurn
      ? " Any child turn clears the prior-refusal flag, so a later refusal still gets a turn while step budget remains, and that turn costs a step. The run ends on a second refusal with no child turn in between, or when no step budget is left."
      : " Re-finish without the marker; that needs no child turn. If the re-finish is refused again anyway, the run ends, because nothing cleared the prior-refusal flag in between.";
  return {
    prompt: refusalPrompt(
      `Finish refused: ${reason}. ${refusals.map((entry) => entry.recovery).join(" ")}${ending}`,
    ),
  };
}

/**
 * The refusal of the `--compare-head` check for one finish, or null when the PR head equals the
 * reviewed commit and the reviewed tree is clean. The only retry is a reviewer turn, which re-reads
 * the reviewed state. No required-check source is read.
 * @param {object} options
 * @returns {Promise<{ reason: string, recovery: string } | null>}
 */
async function headCompareGate({ pr, reviewed, cwd, gh, signal }) {
  const { refusal } = await readGate({
    read: () => checkPrHead({ pr, reviewed, cwd, gh, signal }),
    failedLog: "head compare could not run",
    failedReason: "the PR head compare could not be evaluated",
    failedRecovery: `That is a failure to read GitHub, not a verdict on the work. The only retry you can make is a reviewer turn, which re-reads the reviewed state, then a finish that compares PR ${pr} again. The finish carries no unresolvedCompare marker, because the runtime resolves the PR head from PR ${pr}.`,
    refusedRecovery: `That condition is read from PR ${pr} by the compare, so the finish carries no unresolvedCompare marker. Dispatch the reviewer to re-read the state, then finish. If the condition is about the change, dispatch the worker first and then the reviewer on the new state: a worker turn resets the reviewed state to none.`,
  });
  return refusal;
}

/**
 * The outcome of the `--require-ci` gate for one finish: a refusal when the gate
 * refuses, and the base-branch absence when it passes on a branch with no
 * required check. The shared `checkCi` gate resolves the PR head in the runtime,
 * so the outcome comes from a gate result and not from a field the parent set
 * (#293).
 * @param {object} options
 * @returns {Promise<{ refusal: { reason: string, recovery: string } | null, noRequiredChecks: boolean }>}
 */
async function ciGate({ pr, reviewed, cwd, gh, signal }) {
  const { refusal, result } = await readGate({
    read: () => checkCi({ pr, reviewed, cwd, gh, signal }),
    failedLog: "ci gate could not run",
    failedReason: "the PR gate could not be evaluated",
    // The run is not out of attempts here: any child turn clears the flag that
    // records the prior refusal, so a later refusal still gets a corrective
    // turn while step budget remains. The orchestrator cannot reach a
    // credential or a network itself, so the only retry it owns is the next
    // gate read.
    failedRecovery: `That is a failure to read GitHub, not a verdict on the work, and the fix is outside this run's reach. The only retry you can make is a reviewer turn, which re-reads the reviewed state and re-runs the gate; a worker turn resets that state to none, so it does not retry the gate. The finish carries no unresolvedCompare marker either way, because the gate resolves the PR head from PR ${pr}.`,
    // A reviewer turn is what the gate needs, because only a reviewer turn
    // establishes the reviewed state the gate reads. A worker turn is needed
    // first only when the condition is about the change itself, and it needs a
    // reviewer turn after it either way (#293).
    refusedRecovery: `That condition is read from PR ${pr} by the gate, so the finish carries no unresolvedCompare marker. Dispatch the reviewer to re-read the state and re-run the gate, then finish. If the condition is about the change rather than the checks, dispatch the worker first and then the reviewer on the new state: a worker turn resets the reviewed state to none, so on its own it satisfies neither the gate nor the completion rule.`,
  });
  return { refusal, noRequiredChecks: result?.ok === true && result.noRequiredChecks === true };
}
