import { defaultAgents, runAgent } from "./agents/index.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { checkCi, DEFAULT_READ_TIMEOUT_MS, readRequiredChecks } from "./lib/ci-gate.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { reviewedState, withMutationCheck } from "./lib/snapshot.mjs";
import { decide } from "./orchestrator.mjs";
import { parseReportBlock, parseVerdict } from "./lib/report.mjs";
import { initialPrompt, refusalPrompt, resultPrompt } from "./prompts/orchestrator.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

/**
 * Every CLI call goes through here. Emits one `invocation` event per call, carrying the
 * usage the adapter exposed on `state.usage`, and clears that field so it never lingers.
 */
async function invoke(agents, state, roleName, prompt, opts, onEvent, stepsUsed) {
  delete state.usage;
  const emit = (status) => {
    const event = { type: "invocation", role: roleName, status, stepsUsed };
    if (state.usage) {
      event.usage = state.usage;
      delete state.usage;
    }
    onEvent(event);
  };
  let response;
  try {
    response = await runAgent(state, prompt, { ...opts, role: roleName }, agents);
  } catch (err) {
    emit("error");
    throw err;
  }
  emit("ok");
  return response;
}

/**
 * Run one worker or reviewer turn with the same guards as the headless loop:
 * role prompt wrapping, read-only mutation check for the reviewer, timeout,
 * and cancel propagation. Returns `{ role, status, response }` on success and
 * `{ role, status: "error", error }` on a handled failure. Throws on fatal
 * errors: detected mutation, snapshot failure, or cancel.
 * A reviewer result also carries `reviewed`, the runtime-owned identity of the
 * work tree the reviewer saw, and `prChecks`, the required-check status the
 * runtime read for a declared PR (#320).
 * @param {object} options
 * @returns {Promise<{ role: string, status: "ok", response: string, reviewed?: object, prChecks?: object } | { role: string, status: "error", error: string }>}
 */
export async function runChild(options) {
  const {
    agents = defaultAgents,
    role,
    roleName,
    prompt,
    cwd,
    timeout,
    signal,
    stepsUsed = 0,
    pr = null,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const isWorker = roleName === "worker";
  const readOnly = !isWorker;

  const runFn = (finalPrompt) =>
    invoke(
      agents,
      role,
      roleName,
      finalPrompt,
      { cwd, readOnly, timeout, signal },
      onEvent,
      stepsUsed,
    );

  // The worker prompt needs no runtime read, so it is built once here. The
  // reviewer prompt is built inside the mutation check, where the pre-turn
  // snapshot gives the local head the status read compares against (#320).
  const workerFinalPrompt = isWorker ? workerPrompt(prompt, role.sessionId === null) : null;

  /**
   * Reads the required-check status a declared-PR run supplies to the reviewer,
   * using the pre-turn snapshot head as the local head. A failed read, a
   * mismatched head, and a stalled read are all an unresolved status rather than
   * a turn failure, and the reviewer keeps its own read as the fallback
   * (issue #320). The status covers the PR head on GitHub, so it is evidence
   * for the reviewer, not a gate.
   *
   * known-limit: a headless run that takes only `--require-ci` and declares no
   * `--pr` reads no status, because `pr` is the PR input both paths know at
   * dispatch. The reviewer's own read stays the source there.
   */
  const readStatus = async (head) => {
    if (roleName !== "reviewer" || pr === null) {
      return null;
    }
    const status = await readRequiredChecks({ pr, cwd, head, gh, timeoutMs: readTimeoutMs });
    logInfo(`runtime read the required checks for PR ${pr}: ${status.summary}`);
    return status;
  };

  try {
    let reviewed = null;
    let prChecks = null;
    const response = readOnly
      ? await withMutationCheck(cwd, roleName, async (before) => {
          // The reviewed state comes from the runtime snapshot, never from the
          // child response, so the child cannot misreport it.
          if (roleName === "reviewer") {
            reviewed = reviewedState(before);
            prChecks = await readStatus(reviewed.head);
          }
          return runFn(isWorker ? workerFinalPrompt : reviewerPrompt(prompt, prChecks));
        })
      : await runFn(workerFinalPrompt);
    return {
      role: roleName,
      status: "ok",
      response,
      ...(reviewed ? { reviewed } : {}),
      ...(prChecks ? { prChecks } : {}),
    };
  } catch (err) {
    if (err?.name === "MutationError" || err?.name === "SnapshotError" || err?.isCanceled) {
      if (err?.isCanceled) {
        logError(`${roleName} canceled by signal`);
      }
      throw err;
    }
    let errorMessage = err?.message ?? String(err);
    if (err?.timedOut) {
      errorMessage = `${roleName} timed out after ${timeout} seconds`;
    }
    logWarn(err?.timedOut ? errorMessage : `${roleName}: ${errorMessage.split("\n")[0]}`);
    return { role: roleName, status: "error", error: errorMessage };
  }
}

/**
 * Process exit code for a recorded finish that carries `unresolvedCompare`. The
 * loop still records the finish and prints its summary; the code is what tells
 * an exit-code-only consumer that the PR-head compare was not verified (#279).
 * It is 4, not 3, because 3 is the harness-refusal code of `harness-check`.
 */
export const UNRESOLVED_COMPARE_EXIT = 4;

/**
 * Run the orchestrator loop. Returns `{ exitCode: 0, summary, unresolvedCompare }`
 * when the orchestrator returns `finish`, or `{ exitCode: 1 | 2, reason }` on
 * `abort`, a refused finish, or a step limit reached with work remaining. Throws
 * on fatal controller errors: orchestrator failure, detected mutation, or cancel.
 * A finish whose action set `unresolvedCompare` emits an `unresolved-compare`
 * event and reports `unresolvedCompare: true`, which the headless CLI maps to
 * `UNRESOLVED_COMPARE_EXIT` (#266, #279).
 *
 * With `requireCi`, the shared `checkCi` gate resolves the PR head in the
 * runtime against the last reviewer turn's reviewed state, so a finish no
 * longer depends on the parent reporting the compare. A `gh` failure inside the
 * gate is a refusal rather than a throw, because the headless run has no retry
 * outside it (#293). Every applicable gate is evaluated and every refusal is
 * reported in one prompt, ordered as in the interactive `role finish`: the
 * marker combination, the completion rule, then the gate. The marker is satisfied
 * by editing the finish action, so a finish refused for the marker alone recovers
 * with a re-finish and no child turn, and that re-finish is a repeat refusal if
 * anything else refuses it. Every other refusal needs a child turn to satisfy it,
 * and any child turn separately clears the prior-refusal flag; a second refused
 * finish with no child turn in between ends the run. That turn costs a step, so a
 * finish refused for a pending check consumes step budget to satisfy it, and a
 * worker turn is needed only when the condition is about the change: a worker
 * turn resets the reviewed state to none, and a gate reads that state, which only
 * a reviewer turn establishes. Without the flag the marker stays the only trace,
 * and an omitted marker still reads as a verified finish (#286).
 *
 * With `pr`, the run declares that its work is delivered on that pull request,
 * so a finish must end through the `requireCi` gate for the same PR. A missing
 * gate, or a gate naming another PR, refuses the finish and reads as a PR-gate
 * condition, so it is reported with the other refusals in the same order. A
 * declared run refuses the unresolved-compare marker the same way a gated run
 * does, and that refusal is collected with the rest rather than replacing them.
 * The gate flag is a run input, so no child turn satisfies that refusal and its
 * recovery names `abort` as the outcome the orchestrator owns. A run with
 * neither `pr` nor `requireCi` behaves exactly as before (#302).
 *
 * With `requireAccept`, the runtime refuses a `finish` that a reviewer has not
 * covered: after a worker turn it needs a later reviewer `verdict: accept` with
 * a Checks line, and with no worker turn it needs at least one reviewer report.
 * A refused finish gets one corrective turn; a repeated refusal, or a refusal
 * with no step budget left, ends the run with exit 1. The gate follows turn
 * order only: an edit made outside the loop between the accept and the finish
 * is not detected.
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
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const { orchestrator, worker, reviewer } = roles;

  logInfo(`agent loop started (cwd: ${cwd}, maxSteps: ${maxSteps})`);

  function stopLoop(exitCode, detail) {
    // A recorded unresolved compare leaves the loop on 0 while the headless
    // process exits UNRESOLVED_COMPARE_EXIT, so the log names it (#279).
    const marker = detail.unresolvedCompare ? ", unresolved compare recorded" : "";
    logInfo(`agent loop stopped (exit ${exitCode}${marker})`);
    return { exitCode, ...detail };
  }

  let stepsUsed = 0;
  // Completion gate state (#234). The headless loop has no mode: a worker turn
  // marks work mode and needs a later reviewer accept; no worker turn maps to
  // review-only and needs at least one reviewer report.
  let workerRan = false;
  let reviewerRan = false;
  let acceptedSinceWorker = false;
  let finishRefused = false;
  // The reviewed state the `--require-ci` gate reads: the runtime-owned identity
  // of the last reviewer turn, reset to none by any later turn, so a change made
  // after that review cannot be gated against the older head (#293). It mirrors
  // the interactive `lastResult.reviewed` the role gate reads.
  let lastReviewed = null;

  const orchAdapter = {
    async run(state, p, opts) {
      return withMutationCheck(cwd, "orchestrator", () =>
        invoke(agents, state, "orchestrator", p, opts, onEvent, stepsUsed),
      );
    },
  };

  let prompt = initialPrompt({
    task,
    maxSteps,
    requireAccept,
    pr,
    requireCi,
    orchestratorKind: orchestrator?.kind ?? null,
    reviewerKind: reviewer?.kind ?? null,
  });

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
      if (err?.name !== "MutationError") {
        // A MutationError is already logged at the detection site in withMutationCheck.
        logError(`orchestrator turn failed: ${String(err?.message ?? err).split("\n")[0]}`);
      }
      throw err;
    }

    onEvent({ type: "action", action, stepsUsed });

    if (action.action === "finish") {
      // Every applicable gate is evaluated, and every refusal is reported in one
      // prompt, because the run grants a single corrective turn and a second
      // refused finish ends it. Reporting one condition at a time would spend
      // that turn on a condition the next refusal names instead, which is how a
      // prompt that says "finish again" becomes an exit 1 (#293). The order
      // matches the interactive `role finish`: the marker condition, the
      // completion rule, the declared-PR gate condition, then the PR gate. The
      // `--pr` declaration is the PR input, so its refusal sits where the gate
      // sits (#302).
      const refusals = [];
      // The marker is satisfied by editing the finish action itself, so it is the
      // one refusal that a re-finish can satisfy without a child turn. Every other
      // refusal needs one, and forcing it on the marker would spend a step and
      // start a review cycle the run did not need (#293).
      let needsChildTurn = false;
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
      if (requireAccept && (workerRan ? !acceptedSinceWorker : !reviewerRan)) {
        needsChildTurn = true;
        refusals.push({
          reason: workerRan
            ? "no reviewer accept with a Checks line on the latest changed state after a worker turn"
            : "no reviewer report on the state",
          recovery: `Dispatch the reviewer, obtain ${
            workerRan ? "Verdict: accept with a Checks line on that state" : "a reviewer report"
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
        const gate = await ciRefusal({ pr: requireCi, reviewed: lastReviewed, cwd, gh });
        if (gate) {
          // The gate reads the reviewed state, which only a reviewer turn
          // establishes, so a gate refusal always needs a child turn (#293).
          needsChildTurn = true;
          refusals.push(gate);
        }
      }
      if (refusals.length === 0) {
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
        return stopLoop(0, { summary: action.summary, unresolvedCompare });
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
        return stopLoop(1, { reason: `Finish refused: ${reason}.` });
      }
      finishRefused = true;
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
      prompt = refusalPrompt(
        `Finish refused: ${reason}. ${refusals.map((entry) => entry.recovery).join(" ")}${ending}`,
      );
      continue;
    }

    if (action.action === "abort") {
      return stopLoop(1, { reason: action.reason });
    }

    if (stepsUsed >= maxSteps) {
      return stopLoop(2, { reason: "Step limit reached with work remaining." });
    }

    stepsUsed += 1;
    const isWorkerDispatch = action.action === "run_worker";
    const targetRole = isWorkerDispatch ? worker : reviewer;
    const roleName = isWorkerDispatch ? "worker" : "reviewer";

    const result = await runChild({
      agents,
      role: targetRole,
      roleName,
      prompt: action.prompt,
      cwd,
      timeout,
      signal,
      stepsUsed,
      // The declared PR is the run's PR input, so it is known before the turn and
      // supplies the reviewer with the required-check status (#320). A run with no
      // declaration reads nothing, and the reviewer keeps its own read.
      pr,
      gh,
      readTimeoutMs,
      onEvent,
    });
    onEvent({ type: "result", role: roleName, result, stepsUsed });

    lastReviewed = result.reviewed ?? null;

    if (isWorkerDispatch) {
      workerRan = true;
      acceptedSinceWorker = false;
    } else {
      reviewerRan = reviewerRan || result.status === "ok";
      acceptedSinceWorker = result.status === "ok" && isAcceptedReview(result.response);
    }
    finishRefused = false;

    prompt = resultPrompt({ result, stepsUsed, maxSteps });
  }
}

// The marker refusal a gated run gets, kept as a constant so the shared reason
// function cannot drift apart on the wording.
const UNRESOLVED_COMPARE_WITH_CI =
  "unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved";

/**
 * The marker refusal for the run's PR input, or null when the run declares
 * neither a gate nor a PR, where the marker stays the only record. A declared
 * PR run needs the gate the same way a gated run does, so it refuses the marker
 * too and names the gate it must reach instead of a flag it never carried
 * (#302). The two paths share this function so the wording cannot drift.
 * @param {object} options
 * @returns {string | null}
 */
export function unresolvedCompareReason({ pr = null, requireCi = null }) {
  if (requireCi !== null) {
    return UNRESOLVED_COMPARE_WITH_CI;
  }
  if (pr !== null) {
    return `unresolvedCompare cannot be combined with a run that declares PR ${pr} (--pr): the run must end through the --require-ci ${pr} gate, which resolves that PR head, so that compare is not unresolved`;
  }
  return null;
}

/**
 * The refusal a `--pr <pr>` declaration gives when the run carries no gate for
 * that PR, whether the gate is absent or names another pull request. A gate flag
 * is a run input, so no turn in the run can supply it and the refusal ends the
 * run; the recovery names `abort` as the only outcome the orchestrator owns.
 * @param {number} pr the declared PR
 * @param {number | null} requireCi the gate PR, or null when no gate was passed
 * @returns {{ reason: string, recovery: string }}
 */
export function missingGateRefusal(pr, requireCi) {
  const state =
    requireCi === null
      ? "this run carries no --require-ci gate"
      : `this run gates PR ${requireCi} instead`;
  return {
    reason: `this run declares PR ${pr}, so a finish must end through the --require-ci ${pr} gate, and ${state}`,
    recovery: `The gate flag is a run input, so no worker or reviewer turn can supply it, and a re-finish repeats this refusal. The only outcome you own is abort with the reason naming the missing --require-ci ${pr} gate, because this run cannot end through finish. A finish that records the unresolved compare is refused with this, because the gate resolves that PR head.`,
  };
}

/**
 * The reason `--require-ci` refuses a finish, or null when the gate allows it.
 * The shared `checkCi` gate resolves the PR head in the runtime, so the outcome
 * comes from a gate result and not from a field the parent set (#293).
 *
 * A `gh` failure is a refusal, not a thrown error: `checkCi` throws on an
 * unreadable PR, repository, or API reply, and in the interactive path that
 * error leaves the run `active` for the parent to retry. The headless run has
 * no retry outside this refusal, so throwing would discard a run that a later
 * turn could pass. The refusal fails closed either way, and any child turn
 * clears the prior-refusal flag, so a retry costs a step rather than ending the
 * run.
 * @param {object} options
 * @returns {Promise<{ reason: string, recovery: string } | null>}
 */
async function ciRefusal({ pr, reviewed, cwd, gh }) {
  let gate;
  try {
    gate = await checkCi({ pr, reviewed, cwd, gh });
  } catch (err) {
    const detail = (err?.message ?? String(err)).split("\n")[0];
    logError(`ci gate could not run: ${detail}`);
    return {
      reason: `the PR gate could not be evaluated: ${detail}`,
      // The run is not out of attempts here: any child turn clears the flag that
      // records the prior refusal, so a later refusal still gets a corrective
      // turn while step budget remains. The orchestrator cannot reach a
      // credential or a network itself, so the only retry it owns is the next
      // gate read.
      recovery: `That is a failure to read GitHub, not a verdict on the work, and the fix is outside this run's reach. The only retry you can make is a reviewer turn, which re-reads the reviewed state and re-runs the gate; a worker turn resets that state to none, so it does not retry the gate. The finish carries no unresolvedCompare marker either way, because the gate resolves the PR head from PR ${pr}.`,
    };
  }
  if (gate.ok) {
    return null;
  }
  return {
    reason: gate.reason,
    // A reviewer turn is what the gate needs, because only a reviewer turn
    // establishes the reviewed state the gate reads. A worker turn is needed
    // first only when the condition is about the change itself, and it needs a
    // reviewer turn after it either way (#293).
    recovery: `That condition is read from PR ${pr} by the gate, so the finish carries no unresolvedCompare marker. Dispatch the reviewer to re-read the state and re-run the gate, then finish. If the condition is about the change rather than the checks, dispatch the worker first and then the reviewer on the new state: a worker turn resets the reviewed state to none, so on its own it satisfies neither the gate nor the completion rule.`,
  };
}

// An accept counts only with a Checks line in the closing block, matching the
// parent rule the prompt states (#217) and the interactive --require-accept gate
// (issue #218). An accept without a Checks line is treated as not accepted.
function isAcceptedReview(response) {
  return parseVerdict(response) === "accept" && Boolean(parseReportBlock(response)?.checks);
}
