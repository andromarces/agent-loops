import { defaultAgents, runAgent } from "./agents/index.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { withMutationCheck } from "./lib/snapshot.mjs";
import { decide } from "./orchestrator.mjs";
import { initialPrompt, resultPrompt } from "./prompts/orchestrator.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

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

  async function runRole(role, roleName, prompt, readOnly) {
    const runFn = async () => {
      return runAgent(
        role,
        prompt,
        {
          cwd,
          readOnly,
          timeout,
          signal,
          role: roleName,
        },
        agents,
      );
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
      return withMutationCheck(cwd, "orchestrator", () =>
        runAgent(state, p, { ...opts, role: "orchestrator" }, agents),
      );
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
