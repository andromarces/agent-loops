import { defaultAgents, runAgent } from "./agents/index.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { checkCi } from "./lib/ci-gate.mjs";
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
 * work tree the reviewer saw.
 * @param {object} options
 * @returns {Promise<{ role: string, status: "ok", response: string, reviewed?: object } | { role: string, status: "error", error: string }>}
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
    onEvent = () => {},
  } = options;

  const isWorker = roleName === "worker";
  const readOnly = !isWorker;
  const finalPrompt = isWorker
    ? workerPrompt(prompt, role.sessionId === null)
    : reviewerPrompt(prompt);

  const runFn = () =>
    invoke(
      agents,
      role,
      roleName,
      finalPrompt,
      { cwd, readOnly, timeout, signal },
      onEvent,
      stepsUsed,
    );

  try {
    let reviewed = null;
    const response = readOnly
      ? await withMutationCheck(cwd, roleName, (before) => {
          // The reviewed state comes from the runtime snapshot, never from the
          // child response, so the child cannot misreport it.
          if (roleName === "reviewer") {
            reviewed = reviewedState(before);
          }
          return runFn();
        })
      : await runFn();
    return { role: roleName, status: "ok", response, ...(reviewed ? { reviewed } : {}) };
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
 * longer depends on the parent reporting the compare. Refusals are ordered as
 * in the interactive `role finish`: the marker combination, then the completion
 * rule, then the gate. A refusal names the condition and takes the same
 * corrective-turn path, and a `gh` failure inside the gate is a refusal rather
 * than a throw, because the headless run has no retry outside it (#293). Each
 * refusal ends the run when repeated or when no step budget is left, so a
 * finish refused for a pending check needs a corrective turn, which costs a
 * step. Without the flag the marker stays the only trace, and an omitted marker
 * still reads as a verified finish (#286).
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
    requireCi = null,
    gh,
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
  // of the last reviewer turn, cleared by any later turn, so a change made after
  // that review cannot be gated against the older head (#293). It mirrors the
  // interactive `lastResult.reviewed` the role gate reads.
  let lastReviewed = null;

  const orchAdapter = {
    async run(state, p, opts) {
      return withMutationCheck(cwd, "orchestrator", () =>
        invoke(agents, state, "orchestrator", p, opts, onEvent, stepsUsed),
      );
    },
  };

  let prompt = initialPrompt({ task, maxSteps, requireAccept, requireCi });

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
      // Refusal order matches the interactive `role finish`: the marker
      // combination first, then the completion rule, then the PR gate (#293).
      // A finish that sets the marker under the gate is refused before any
      // reviewer work, because the marker is a contract violation the gate
      // already settles.
      const markerRefusal =
        requireCi !== null && action.unresolvedCompare === true
          ? {
              reason: UNRESOLVED_COMPARE_WITH_CI,
              recovery:
                "The gate resolves that PR head, so remove unresolvedCompare from the finish, then finish again.",
            }
          : null;
      const acceptRefusal =
        markerRefusal || !requireAccept || (workerRan ? acceptedSinceWorker : reviewerRan)
          ? null
          : {
              reason: workerRan
                ? "no reviewer accept with a Checks line on the latest changed state after a worker turn"
                : "no reviewer report on the state",
              recovery: `Dispatch the reviewer, obtain ${
                workerRan ? "Verdict: accept with a Checks line on that state" : "a reviewer report"
              }, then finish.`,
            };
      // The gate resolves the PR head in the runtime, which is what the parent
      // can no longer misreport. Its own failure is a refusal rather than a
      // thrown error, so a `gh` failure does not discard a run that is one
      // retry from passing (#293).
      const gateRefusal =
        markerRefusal || acceptRefusal || requireCi === null
          ? null
          : await ciRefusal({ pr: requireCi, reviewed: lastReviewed, cwd, gh });
      const refusal = markerRefusal ?? acceptRefusal ?? gateRefusal;
      if (refusal === null) {
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
      onEvent({ type: "refusal", reason: refusal.reason, stepsUsed });
      // A refusal gets one corrective turn. With no step budget left that turn
      // cannot run a child, so the refusal resolves here on the exit-1 path
      // instead of reaching the step-limit exit 2 (#248).
      if (finishRefused || stepsUsed >= maxSteps) {
        return stopLoop(1, { reason: `Finish refused: ${refusal.reason}.` });
      }
      finishRefused = true;
      logWarn(`finish refused: ${refusal.reason}`);
      prompt = refusalPrompt(`Finish refused: ${refusal.reason}. ${refusal.recovery}`);
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

/**
 * The marker refusal both paths share, kept as a constant so the headless gate
 * and `role finish` cannot drift apart on the wording.
 */
export const UNRESOLVED_COMPARE_WITH_CI =
  "unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved";

/**
 * The reason `--require-ci` refuses a finish, or null when the gate allows it.
 * The shared `checkCi` gate resolves the PR head in the runtime, so the outcome
 * comes from a gate result and not from a field the parent set (#293).
 *
 * A `gh` failure is a refusal, not a thrown error: `checkCi` throws on an
 * unreadable PR, repository, or API reply, and in the interactive path that
 * error leaves the run `active` for the parent to retry. The headless run has
 * no retry outside this refusal, so throwing would discard a run that a second
 * attempt could pass. The refusal fails closed either way, and its recovery
 * text says the run can be finished again without another child turn, which a
 * pending or failing check may need.
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
      recovery: `That is a failure to read GitHub, not a verdict on the work. Fix the credential or the connection, then finish again; the gate resolves the PR head from PR ${pr}, so the finish carries no unresolvedCompare marker.`,
    };
  }
  if (gate.ok) {
    return null;
  }
  return {
    reason: gate.reason,
    recovery: `That condition is read from PR ${pr} by the gate, so the finish carries no unresolvedCompare marker. Resolve it, then finish again; a pending or failing check clears when the check reports, and a re-finish costs no step.`,
  };
}

// An accept counts only with a Checks line in the closing block, matching the
// parent rule the prompt states (#217) and the interactive --require-accept gate
// (issue #218). An accept without a Checks line is treated as not accepted.
function isAcceptedReview(response) {
  return parseVerdict(response) === "accept" && Boolean(parseReportBlock(response)?.checks);
}
