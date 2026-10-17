import { defaultAgents } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import {
  checkCi,
  DEFAULT_READ_TIMEOUT_MS,
  missingGateRefusal,
  unresolvedCompareReason,
} from "./lib/ci-gate.mjs";
import { copyLocalFiles as copyIntoWorkTree } from "./lib/local-files.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import {
  applyResult,
  freshGate,
  matchingGate,
  refuseDeclaredPrConflict,
  resetGate,
} from "./lib/continuation.mjs";
import { withMutationCheck } from "./lib/snapshot.mjs";
import { resolveWorkerPr } from "./lib/worker-pr.mjs";
import { invoke, runChild } from "./child-turn.mjs";
import { decide } from "./orchestrator.mjs";
import { failedTestRun, testCmdInput } from "./lib/test-cmd.mjs";
import { initialPrompt, refusalPrompt, resultPrompt } from "./prompts/orchestrator.mjs";

/**
 * Runs one read-only probe turn in a new session and reads `state.resolvedModel` from it (#394). The
 * probe is a child turn, so it runs under the same mutation check as a reviewer turn: a probe that
 * changes the work tree throws `MutationError`, a failed snapshot throws `SnapshotError`, and
 * `signal` cancels the CLI call. Every error is thrown, never returned as a result, because the
 * caller refuses the continuation on any failure.
 * @param {{ agents?: object, state: object, roleName: string, cwd: string, timeout?: number | null, signal?: AbortSignal }} options
 */
export async function runProbeTurn({
  agents = defaultAgents,
  state,
  roleName,
  cwd,
  timeout,
  signal,
}) {
  await withMutationCheck(
    cwd,
    roleName,
    () =>
      invoke({
        agents,
        state,
        roleName,
        prompt: "Reply with the single word OK.",
        opts: { cwd, readOnly: true, timeout, signal },
        onEvent: () => {},
        stepsUsed: 0,
      }),
    { signal },
  );
  // A cancel can land in the post-turn snapshot, after the adapter returned (#587).
  throwIfCanceled(signal, roleName);
}

/**
 * Process exit code for a recorded finish that carries `unresolvedCompare`. The
 * loop still records the finish and prints its summary; the code is what tells
 * an exit-code-only consumer that the PR-head compare was not verified (#279).
 * It is 4, not 3, because 3 is the harness-refusal code of `harness-check`.
 */
export const UNRESOLVED_COMPARE_EXIT = 4;

/**
 * Runs the orchestrator loop. Returns `{ exitCode: 0, summary, unresolvedCompare }`
 * when the orchestrator returns `finish`, or `{ exitCode: 1 | 2, reason }` on
 * `abort`, a refused finish, or a step limit reached with work remaining. Throws
 * on fatal controller errors: orchestrator failure, detected mutation, or cancel.
 * A finish that records `unresolvedCompare` emits an `unresolved-compare` event
 * and reports `unresolvedCompare: true`, which the headless CLI maps to
 * `UNRESOLVED_COMPARE_EXIT` (#266, #279).
 *
 * Finish gates: every applicable refusal is reported in one prompt, in the order
 * of the interactive `role finish`: the unresolved-compare marker, the completion
 * rule, the declared-PR condition, then the `requireCi` gate. A refused finish
 * gets one corrective turn, which costs a step, unless no step budget is left or
 * no child turn has run since the previous refusal. Either case ends the run with
 * exit 1. A refusal for the marker alone recovers with a re-finish and no child
 * turn. A worker turn resets the reviewed state to none, and only a reviewer turn
 * establishes it, so after a worker turn the gates need a later reviewer turn.
 * - `requireCi`: `checkCi` resolves the PR head against the last reviewer turn's
 *   reviewed state. A `gh` failure is a refusal, not a throw. A pass on a base
 *   branch with no required check emits a `no-required-checks` event (#293, #336).
 * - `pr`: the run declares its delivery PR, so a finish must pass `requireCi` for
 *   the same PR. No child turn satisfies a missing or mismatched gate, so that
 *   refusal ends the run on a re-finish (#302).
 * - `requireAccept`: a finish needs a later reviewer `verdict: accept` with a
 *   Checks line after a worker turn, or at least one reviewer report with no
 *   worker turn. The gate follows turn order only: an edit made outside the loop
 *   between the accept and the finish is not detected.
 *
 * `mode`: the loop policy, with the values of the interactive `--mode`. `review-only`
 * dispatches no worker, so the CLI refuses `pr`, `requireAccept`, and `requireCi`,
 * the loop refuses a `run_worker` action, and a `finish` waits for a completed
 * reviewer turn (#337).
 * `continued`: the run resumes the sessions of an earlier headless run. With neither `pr` nor
 * `requireCi`, it takes `earlierPr`, the PR that the earlier run declared (see
 * `declaredPrFromTranscript`), and emits a `pr-declared` event with `restored: true`. The gate
 * state is restored only when `earlierGate` (see `gateFromTranscript`) is valid and
 * the work tree has the head and digest of its last reviewer turn. Otherwise it
 * resets and counts the work as unreviewed, so a finish under `requireAccept`
 * needs a reviewer accept in this run. A restore takes `lastReviewed` from the
 * current snapshot, never from the record (#362, #393).
 * `copyLocalFiles` (default true): before the first turn and snapshot, copies the
 * untracked, ignored local files of the main work tree into a linked `cwd` and
 * emits one `local-files` event with the copied and skipped names (ADR 0018).
 * `testCmd`: runs in `cwd` before each reviewer turn. The result is advisory
 * `testRun` evidence in the reviewer prompt and the result event. `testCmdTimeout`
 * bounds one run in seconds (ADR 0017).
 * `reviewerSandbox`: the mode of a Codex reviewer turn: `none` (default, runs
 * `danger-full-access`), `read-only`, or `workspace-write` with network off. A
 * reviewer that is not Codex has no mode. The reviewer and orchestrator prompts
 * state it, and worker turns get none. The mutation check wraps every reviewer
 * turn (ADR 0019, ADR 0038).
 * `onSessionAssigned(roleName, id)`: awaited for any role whose adapter pre-assigns
 * a session id (the Claude adapter), before its CLI starts, and with `null` when
 * the CLI rejected the id. It does not change the role state. The caller records
 * the id and its unconfirmed mark (ADR 0016).
 * @param {object} options
 * @returns {Promise<{ exitCode: 0, summary: object, unresolvedCompare: boolean } | { exitCode: 1 | 2, reason: string }>}
 */
export async function runLoop(options) {
  const {
    task,
    cwd,
    maxSteps = DEFAULT_MAX_STEPS,
    timeout,
    signal,
    roles,
    agents = defaultAgents,
    requireAccept = false,
    pr = null,
    requireCi = null,
    testCmd: testCmdText = null,
    testCmdTimeout = null,
    reviewerSandbox = "none",
    mode = null,
    continued = false,
    earlierGate = null,
    earlierPr = null,
    copyLocalFiles = true,
    onSessionAssigned,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const { orchestrator, worker, reviewer } = roles;
  // Only the Codex adapter applies a mode, so any other reviewer has none.
  const sandboxMode = reviewer?.kind === "codex" ? reviewerSandbox : null;

  // A continued run keeps the PR that the earlier run declared. The CLI refuses a conflict first,
  // and this check holds for any other caller, before the first child spawn.
  refuseDeclaredPrConflict(continued ? earlierPr : null, { pr, requireCi, mode });

  logInfo(`agent loop started (cwd: ${cwd}, maxSteps: ${maxSteps})`);

  // Before the first child spawn and the first snapshot, so the copied files are
  // present for every turn. They are ignored, so no snapshot lists them.
  if (copyLocalFiles) {
    const report = await copyIntoWorkTree(cwd, {}, { signal });
    if (report) {
      onEvent({ type: "local-files", ...report });
    }
  }

  function stopLoop(exitCode, detail) {
    // A recorded unresolved compare leaves the loop on 0 while the headless
    // process exits UNRESOLVED_COMPARE_EXIT, so the log names it (#279).
    const marker = detail.unresolvedCompare ? ", unresolved compare recorded" : "";
    logInfo(`agent loop stopped (exit ${exitCode}${marker})`);
    // The gate state travels with the result, so the CLI can record it in the
    // transcript for a later `--continue-from` to check against a replay (#393).
    return {
      exitCode,
      ...detail,
      gate,
    };
  }

  let stepsUsed = 0;
  // Completion gate state (#234). Without `mode`, a worker turn marks work mode,
  // and work mode needs a later reviewer accept. A run with no worker turn maps
  // to review-only and needs at least one reviewer report. `mode: "review-only"`
  // refuses a worker action. It also refuses a finish before a reviewer turn.
  //
  // A continued run restores the earlier run's gate state only when it is valid
  // and the current work tree is the state that run's last reviewer turn
  // reviewed (#393). The CLI derives `earlierGate` from the result events of the
  // earlier transcript, never from a stored flag.
  // Otherwise it resets conservatively (#362): the tree counts as changed and
  // unreviewed, so a reviewer accept on the current state is what
  // `--require-accept` needs, and `reviewerRan`, `lastReviewed`, and the
  // review-only turn flag start empty, so every gate reads only this run.
  const restoredGate = continued ? await matchingGate(earlierGate, cwd, { signal }) : null;
  // `reviewerTurnDispatched` counts any reviewer turn, whatever it returned, while `reviewerRan`
  // counts only one that ended `ok`, because `--require-accept` reads that one (#337).
  // `lastReviewed` is the runtime-owned identity of the last reviewer turn that the `--require-ci`
  // gate reads. Any later turn resets it, so a change made after that review cannot be gated
  // against the older head (#293).
  let gate = restoredGate ?? (continued ? resetGate() : freshGate());
  let finishRefused = false;
  // The PR input of the run: `--pr` from the start, or the one PR that the runtime resolves after
  // a worker turn when the run has neither `--pr` nor `--require-ci` (ADR 0043). It changes once,
  // from null to a number, and only the runtime sets it. A continued run with neither flag takes
  // the PR that the earlier run declared, so the declared-PR finish rule survives `--continue-from`.
  const restoredPr = continued && pr === null && requireCi === null ? earlierPr : null;
  let declaredPr = pr ?? restoredPr;
  // The event is written for every continuation of a declared run, whatever flags it passes. A
  // flag can only name the declared PR, and a later continuation of this transcript reads the
  // declaration from the event.
  if (continued && earlierPr !== null) {
    logInfo(`runtime kept PR ${earlierPr}, which the earlier run declared`);
    onEvent({ type: "pr-declared", pr: earlierPr, stepsUsed: 0, restored: true });
  }

  // The caller persists a pre-assigned id before the CLI starts, so a parent crash during a first
  // turn leaves it (issue #564). The role state is not touched here: the adapter owns it.
  const assignedHook = onSessionAssigned && ((roleName) => (id) => onSessionAssigned(roleName, id));

  const instructions = initialPrompt({
    task,
    maxSteps,
    requireAccept,
    pr: declaredPr,
    requireCi,
    testCmd: testCmdText !== null,
    reviewerSandbox: sandboxMode,
    mode,
    continued,
    gateRestored: restoredGate !== null,
    timeout,
    cwd,
    orchestratorKind: orchestrator?.kind ?? null,
    reviewerKind: reviewer?.kind ?? null,
  });

  // An adapter sets `conversationReplaced` when a resume ran the turn in a new conversation, which
  // never received `instructions`. The turn is read-only, so a rerun repeats no edit: it carries the
  // instructions before the same prompt, and its answer replaces the one the instructionless
  // conversation gave. Each call has its own mutation check, so an edit of the first call is
  // detected before the rerun can restore it. The earlier turns of the old conversation are lost.
  // One rerun only, and the mark is cleared on every exit (issue #396, ADR 0016).
  const orchAdapter = {
    async run(state, p, opts) {
      const call = (text) => {
        const resumedUnconfirmed = state.sessionId !== null && state.sessionUnconfirmed === true;
        return withMutationCheck(
          cwd,
          "orchestrator",
          async () => {
            try {
              return await invoke({
                agents,
                state,
                roleName: "orchestrator",
                prompt: text,
                opts: assignedHook
                  ? { ...opts, onSessionAssigned: assignedHook("orchestrator") }
                  : opts,
                onEvent,
                stepsUsed,
              });
            } catch (err) {
              // A refused ownership check clears the mark, and the orchestrator has no first-turn
              // rerun: the missing prompt would start a session with no task. The id stays, so it
              // keeps the mark and the next resume checks it again. The restore sits inside the
              // mutation check, because a failed snapshot after the turn replaces this error with
              // one that wraps it (issue #564).
              if (
                resumedUnconfirmed &&
                readProp(err, "sessionMissing") &&
                state.sessionId !== null
              ) {
                state.sessionUnconfirmed = true;
              }
              throw err;
            }
          },
          { signal: opts.signal },
        );
      };
      // The mark of a canceled run reaches a continued run, whose first prompt is `instructions`,
      // so no turn needs a carried mark. `instructionsPending` is true while a replaced
      // conversation has not received the instructions.
      let instructionsPending = false;
      let keepReplacedMark = false;
      try {
        let response = await call(p);
        if (state.conversationReplaced && p !== instructions) {
          delete state.conversationReplaced;
          instructionsPending = true;
          logWarn(
            "orchestrator: conversation was replaced; rerunning the turn with its instructions",
          );
          response = await call(
            `${instructions}\n\nThe conversation restarted and earlier turns are lost. Ignore the request above to choose a first action. Answer the prompt below.\n\n${p}`,
          );
          instructionsPending = false;
        }
        // A cancel can land in the post-turn snapshot, after the adapter returned (#587).
        throwIfCanceled(opts.signal, "orchestrator");
        return response;
      } catch (err) {
        // A canceled turn keeps the id the CLI reported, so a replaced conversation that has not
        // received the instructions keeps its mark (ADR 0027, decision 5).
        if (readProp(err, "isCanceled") && (instructionsPending || state.conversationReplaced)) {
          state.conversationReplaced = true;
          keepReplacedMark = true;
        }
        throw err;
      } finally {
        if (!keepReplacedMark) delete state.conversationReplaced;
      }
    },
  };

  let prompt = instructions;

  while (true) {
    let action;
    try {
      action = await decide({
        agent: orchAdapter,
        state: orchestrator,
        prompt,
        options: { cwd, timeout, signal },
      });
    } catch (err) {
      if (readProp(err, "name") !== "MutationError") {
        // A MutationError is already logged at the detection site in withMutationCheck.
        logError(`orchestrator turn failed: ${firstErrorLine(readableErrorText(err))}`);
      }
      throw err;
    }

    onEvent({ type: "action", action, stepsUsed });

    if (action.action === "finish") {
      const outcome = await evaluateFinish({
        action,
        mode,
        requireAccept,
        pr: declaredPr,
        requireCi,
        gate,
        finishRefused,
        stepsUsed,
        maxSteps,
        cwd,
        gh,
        onEvent,
        stopLoop,
      });
      if (outcome.stop) return outcome.stop;
      finishRefused = true;
      prompt = outcome.prompt;
      continue;
    }

    if (action.action === "abort") {
      return stopLoop(1, { reason: action.reason });
    }

    // review-only dispatches no worker, the same hard guard the interactive path
    // applies to `--role worker`. The run ends rather than retrying the action,
    // because a corrective turn would cost a step to reach the state the run
    // started in (#337).
    if (mode === "review-only" && action.action === "run_worker") {
      onEvent({ type: "refusal", reason: REVIEW_ONLY_WORKER_REFUSAL, stepsUsed });
      return stopLoop(1, { reason: REVIEW_ONLY_WORKER_REFUSAL });
    }

    if (stepsUsed >= maxSteps) {
      return stopLoop(2, { reason: "Step limit reached with work remaining." });
    }

    stepsUsed += 1;
    const isWorkerDispatch = action.action === "run_worker";
    const targetRole = isWorkerDispatch ? worker : reviewer;
    const roleName = isWorkerDispatch ? "worker" : "reviewer";

    let result;
    try {
      result = await runChild({
        agents,
        role: targetRole,
        roleName,
        prompt: action.prompt,
        task,
        cwd,
        timeout,
        signal,
        stepsUsed,
        // The declared PR, or the gated PR when none is declared, is known before
        // the turn and supplies the reviewer with the required-check status (#320,
        // #350). A run with neither reads nothing, and the reviewer keeps its own
        // read. The CLI refuses a `--pr` and a `--require-ci` that name different PRs.
        pr: declaredPr ?? requireCi,
        // The command text comes from the `--test-cmd` run input only (ADR 0017).
        testCmd: testCmdInput(testCmdText, testCmdTimeout),
        reviewerSandbox: sandboxMode,
        ...(assignedHook ? { onSessionAssigned: assignedHook(roleName) } : {}),
        gh,
        readTimeoutMs,
        onEvent,
      });
    } catch (err) {
      // A fatal error ends the run with no result event, so the command result and the
      // work tree compare the runtime already read are emitted here, and the transcript
      // keeps them (ADR 0017).
      const carried = failedTestRun(err);
      if (carried) {
        onEvent({
          type: "test-run",
          role: roleName,
          testRun: carried,
          fatal: true,
          stepsUsed,
        });
      }
      throw err;
    }
    onEvent({ type: "result", role: roleName, result, stepsUsed });

    // Set whatever the turn returned: a reviewer turn that ended in a handled error
    // is still the report a `review-only` finish records (#337). The replay of a
    // continued run applies the same transition (#393).
    gate = applyResult(gate, roleName, result);
    finishRefused = false;

    let newlyDeclared = null;
    if (isWorkerDispatch && declaredPr === null && requireCi === null) {
      newlyDeclared = await declareWorkerPr({ result, cwd, gh, signal, readTimeoutMs });
      if (newlyDeclared !== null) {
        declaredPr = newlyDeclared;
        onEvent({ type: "pr-declared", pr: declaredPr, stepsUsed });
      }
    }

    prompt = resultPrompt({ result, stepsUsed, maxSteps, declaredPr: newlyDeclared });
  }
}

/**
 * Resolves the PR that a worker turn opened, for a run with no PR input (ADR 0043). The head
 * compared is the work tree head that the runtime read after the turn, never a child report.
 * Returns the PR number, or null when the run stays undeclared. A refusal to name one PR is
 * logged as a warning, except for no PR at all, which is the usual state of a task with no PR.
 * @returns {Promise<number | null>}
 */
async function declareWorkerPr({ result, cwd, gh, signal, readTimeoutMs }) {
  if (result.status !== "ok") return null;
  const resolved = await resolveWorkerPr({
    cwd,
    head: result.workTree?.head ?? null,
    gh,
    signal,
    timeoutMs: readTimeoutMs,
  });
  if (resolved.pr === null) {
    if (!resolved.quiet) logWarn(`no PR declared after the worker turn: ${resolved.reason}`);
    return null;
  }
  logInfo(`runtime declared PR ${resolved.pr} after the worker turn`);
  return resolved.pr;
}

/**
 * Evaluates a `finish` action against every applicable gate. Returns `{ stop }`
 * with the loop result when the run ends, or `{ prompt }` with the corrective
 * turn prompt when the first refusal grants one more turn. Emits the
 * `no-required-checks`, `unresolved-compare`, and `refusal` events.
 * @param {object} options
 * @returns {Promise<{ stop: object } | { prompt: string }>}
 */
async function evaluateFinish({
  action,
  mode,
  requireAccept,
  pr,
  requireCi,
  gate,
  finishRefused,
  stepsUsed,
  maxSteps,
  cwd,
  gh,
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
  const declaredGateMissing = pr !== null && requireCi !== pr;
  if (declaredGateMissing) {
    refusals.push(missingGateRefusal(pr, requireCi));
  }
  if (requireCi !== null && !declaredGateMissing) {
    // The gate resolves the PR head in the runtime, which is what the parent
    // can no longer misreport. Its own failure is a refusal rather than a
    // thrown error, so a `gh` failure does not discard a run that a later
    // turn could pass (#293).
    const ci = await ciGate({ pr: requireCi, reviewed: gate.lastReviewed, cwd, gh });
    if (ci.refusal) {
      // The gate reads the reviewed state, which only a reviewer turn
      // establishes, so a gate refusal always needs a child turn (#293).
      needsChildTurn = true;
      refusals.push(ci.refusal);
    } else {
      noRequiredChecks = ci.noRequiredChecks;
    }
  }
  if (refusals.length === 0) {
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
  const ending = declaredGateMissing
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

// The review-only worker refusal, worded after the interactive `--role worker`
// guard it mirrors, so a parent reads one rule on both paths.
const REVIEW_ONLY_WORKER_REFUSAL = "mode review-only rejects a run_worker action";

/**
 * The outcome of the `--require-ci` gate for one finish: a refusal when the gate
 * refuses, and the base-branch absence when it passes on a branch with no
 * required check. The shared `checkCi` gate resolves the PR head in the runtime,
 * so the outcome comes from a gate result and not from a field the parent set
 * (#293).
 *
 * A `gh` failure is a refusal, not a thrown error: `checkCi` throws on an
 * unreadable PR, repository, or API reply, and in the interactive path that
 * error leaves the run `active` for the parent to retry. The headless run has
 * no retry outside this refusal, so throwing would discard a run that a later
 * turn could pass. The refusal fails closed either way, and any child turn
 * clears the prior-refusal flag, so a retry costs a step rather than ending the
 * run.
 * @param {object} options
 * @returns {Promise<{ refusal: { reason: string, recovery: string } | null, noRequiredChecks: boolean }>}
 */
async function ciGate({ pr, reviewed, cwd, gh }) {
  let gate;
  try {
    gate = await checkCi({ pr, reviewed, cwd, gh });
  } catch (err) {
    const detail = firstErrorLine(readableErrorText(err));
    logError(`ci gate could not run: ${detail}`);
    return {
      refusal: {
        reason: `the PR gate could not be evaluated: ${detail}`,
        // The run is not out of attempts here: any child turn clears the flag that
        // records the prior refusal, so a later refusal still gets a corrective
        // turn while step budget remains. The orchestrator cannot reach a
        // credential or a network itself, so the only retry it owns is the next
        // gate read.
        recovery: `That is a failure to read GitHub, not a verdict on the work, and the fix is outside this run's reach. The only retry you can make is a reviewer turn, which re-reads the reviewed state and re-runs the gate; a worker turn resets that state to none, so it does not retry the gate. The finish carries no unresolvedCompare marker either way, because the gate resolves the PR head from PR ${pr}.`,
      },
      noRequiredChecks: false,
    };
  }
  if (gate.ok) {
    return { refusal: null, noRequiredChecks: gate.noRequiredChecks === true };
  }
  return {
    refusal: {
      reason: gate.reason,
      // A reviewer turn is what the gate needs, because only a reviewer turn
      // establishes the reviewed state the gate reads. A worker turn is needed
      // first only when the condition is about the change itself, and it needs a
      // reviewer turn after it either way (#293).
      recovery: `That condition is read from PR ${pr} by the gate, so the finish carries no unresolvedCompare marker. Dispatch the reviewer to re-read the state and re-run the gate, then finish. If the condition is about the change rather than the checks, dispatch the worker first and then the reviewer on the new state: a worker turn resets the reviewed state to none, so on its own it satisfies neither the gate nor the completion rule.`,
    },
    noRequiredChecks: false,
  };
}
