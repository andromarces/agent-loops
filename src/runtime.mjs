import { defaultAgents, runAgent } from "./agents/index.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { withMutationCheck } from "./lib/snapshot.mjs";
import { decide } from "./orchestrator.mjs";
import { parseVerdict } from "./lib/report.mjs";
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
 * @param {object} options
 * @returns {Promise<{ role: string, status: "ok", response: string } | { role: string, status: "error", error: string }>}
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
    const response = readOnly ? await withMutationCheck(cwd, roleName, runFn) : await runFn();
    return { role: roleName, status: "ok", response };
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
 * Run the orchestrator loop. Returns `{ exitCode: 0, summary }` when the
 * orchestrator returns `finish`, or `{ exitCode: 1 | 2, reason }` on `abort`,
 * a refused finish, or a step limit reached with work remaining. Throws on
 * fatal controller errors: orchestrator failure, detected mutation, or cancel.
 *
 * With `requireAccept`, the runtime refuses a `finish` that a reviewer has not
 * covered: after a worker turn it needs a later reviewer `verdict: accept`, and
 * with no worker turn it needs at least one reviewer report. A refused finish
 * gets one corrective turn; a repeated refusal ends the run with exit 1. The
 * gate follows turn order only: an edit made outside the loop between the
 * accept and the finish is not detected.
 * @param {object} options
 * @returns {Promise<{ exitCode: 0, summary: object } | { exitCode: 1 | 2, reason: string }>}
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
    onEvent = () => {},
  } = options;

  const { orchestrator, worker, reviewer } = roles;

  logInfo(`agent loop started (cwd: ${cwd}, maxSteps: ${maxSteps})`);

  function stopLoop(exitCode, detail) {
    logInfo(`agent loop stopped (exit ${exitCode})`);
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

  const orchAdapter = {
    async run(state, p, opts) {
      return withMutationCheck(cwd, "orchestrator", () =>
        invoke(agents, state, "orchestrator", p, opts, onEvent, stepsUsed),
      );
    },
  };

  let prompt = initialPrompt({ task, maxSteps, requireAccept });

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
      const gateBlocks = requireAccept && (workerRan ? !acceptedSinceWorker : !reviewerRan);
      if (!gateBlocks) {
        return stopLoop(0, { summary: action.summary });
      }
      const missing = workerRan
        ? "no reviewer accept on the latest changed state after a worker turn"
        : "no reviewer report on the state";
      if (finishRefused) {
        return stopLoop(1, { reason: `Finish refused: ${missing}.` });
      }
      finishRefused = true;
      logWarn(`finish refused: ${missing}`);
      prompt = refusalPrompt(
        `Finish refused: ${missing}. Dispatch the reviewer, obtain ${
          workerRan ? "Verdict: accept on that state" : "a reviewer report"
        }, then finish.`,
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
      onEvent,
    });
    onEvent({ type: "result", role: roleName, result, stepsUsed });

    if (isWorkerDispatch) {
      workerRan = true;
      acceptedSinceWorker = false;
    } else {
      reviewerRan = reviewerRan || result.status === "ok";
      acceptedSinceWorker = result.status === "ok" && parseVerdict(result.response) === "accept";
    }
    finishRefused = false;

    prompt = resultPrompt({ result, stepsUsed, maxSteps });
  }
}
