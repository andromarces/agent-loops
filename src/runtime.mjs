import { defaultAgents, runAgent } from "./agents/index.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { withMutationCheck } from "./lib/snapshot.mjs";
import { decide } from "./orchestrator.mjs";
import { initialPrompt, resultPrompt } from "./prompts/orchestrator.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

/**
 * Run the orchestrator loop. Returns `{ exitCode: 0, summary }` when the
 * orchestrator returns `finish`, or `{ exitCode: 1 | 2, reason }` on `abort`
 * or a step limit reached with work remaining. Throws on fatal controller
 * errors: orchestrator failure, detected mutation, or cancel.
 * @param {object} options
 * @returns {Promise<{ exitCode: 0, summary: object } | { exitCode: 1 | 2, reason: string }>}
 */
export async function runLoop(options) {
  const {
    task,
    cwd,
    maxSteps = 20,
    timeout,
    signal,
    roles,
    agents = defaultAgents,
    onEvent = () => {},
  } = options;

  const { orchestrator, worker, reviewer } = roles;

  logInfo(`agent loop started (cwd: ${cwd}, maxSteps: ${maxSteps})`);

  function stopLoop(exitCode, detail) {
    logInfo(`agent loop stopped (exit ${exitCode})`);
    return { exitCode, ...detail };
  }

  /**
   * Every CLI call goes through here. Emits one `invocation` event per call, carrying the
   * usage the adapter exposed on `state.usage`, and clears that field so it never lingers.
   */
  async function invoke(state, roleName, prompt, opts) {
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

  async function runRole(role, roleName, prompt, readOnly) {
    const runFn = async () => {
      return invoke(role, roleName, prompt, { cwd, readOnly, timeout, signal });
    };

    if (readOnly) {
      return withMutationCheck(cwd, roleName, runFn);
    }
    return runFn();
  }

  async function runChild(role, roleName, prompt) {
    const isWorker = roleName === "worker";
    const readOnly = !isWorker;
    const finalPrompt = isWorker
      ? workerPrompt(prompt, role.sessionId === null)
      : reviewerPrompt(prompt);

    try {
      const response = await runRole(role, roleName, finalPrompt, readOnly);
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

  const orchAdapter = {
    async run(state, p, opts) {
      return withMutationCheck(cwd, "orchestrator", () => invoke(state, "orchestrator", p, opts));
    },
  };

  let stepsUsed = 0;
  let prompt = initialPrompt({ task, maxSteps });

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
      if (err?.name === "MutationError") {
        // Already logged at the detection site in withMutationCheck.
        throw err;
      }
      logError(`orchestrator turn failed: ${String(err?.message ?? err).split("\n")[0]}`);
      throw err;
    }

    onEvent({ type: "action", action, stepsUsed });

    if (action.action === "finish") {
      return stopLoop(0, { summary: action.summary });
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

    const result = await runChild(targetRole, roleName, action.prompt);
    onEvent({ type: "result", role: roleName, result, stepsUsed });

    prompt = resultPrompt({ result, stepsUsed, maxSteps });
  }
}
