import { defaultAgents, runAgent } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import { DEFAULT_READ_TIMEOUT_MS, readRequiredChecks } from "./lib/ci-gate.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { reviewedState, withMutationCheck } from "./lib/snapshot.mjs";
import {
  carryTestRun,
  failedTestRun,
  reportLateChangedPaths,
  runTestCmd,
} from "./lib/test-cmd.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

// Task of the preamble-only worker turn that follows a replaced conversation.
const PREAMBLE_ONLY_TASK =
  "No task this turn. Reply with the single word OK and change nothing. The rules above apply to every later turn.";

/**
 * Every CLI call goes through here. Emits one `invocation` event per call, carrying the
 * usage the adapter exposed on `state.usage`, and clears that field so it never lingers.
 */
export async function invoke({ agents, state, roleName, prompt, opts, onEvent, stepsUsed }) {
  delete state.usage;
  delete state.shellDenied;
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
  } finally {
    // An orchestrator turn has no result to carry the flag (ADR 0035), so it keeps none. A child
    // turn leaves it for `runChild`, which reads it and clears it.
    if (roleName === "orchestrator") delete state.shellDenied;
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
 * runtime read for a declared PR (#320), and `testRun`, the result of the
 * operator's `--test-cmd` that the runtime ran before the turn (ADR 0017). A
 * handled error result keeps `testRun`, and a fatal error carries it as
 * `err.testRun`, so a turn that fails after the command ran loses no evidence.
 * `failedTestRun` reads that result from a fatal error. It falls back to a
 * `WeakMap` when the error cannot take the `testRun` property.
 * `reviewerSandbox` (`none`, `read-only`, or `workspace-write`) passes the reviewer-only `sandbox`
 * input to a reviewer turn and adds the matching prompt line; no other role receives it, and null
 * passes none (ADR 0019, ADR 0038).
 * `onSessionAssigned(id)` is awaited by an adapter that pre-assigns a session id, before its CLI
 * starts, and with `null` when the CLI rejected that id. A dispatcher uses it to persist the id
 * ahead of a crash (issue #395).
 * @param {object} options
 * @returns {Promise<{ role: string, status: "ok", response: string, reviewed?: object, prChecks?: object, testRun?: object } | { role: string, status: "error", error: string, testRun?: object }>}
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
    testCmd = null,
    reviewerSandbox = null,
    onSessionAssigned,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const isWorker = roleName === "worker";
  const readOnly = !isWorker;
  // A canceled turn leaves `conversationReplaced` set, because the replaced conversation never
  // received the worker preamble (ADR 0027, decision 5). This turn takes the mark over: the worker
  // prompt carries the preamble, and `preamblePending` keeps the mark if this turn is canceled too.
  const carriedReplaced = role.conversationReplaced === true;
  delete role.conversationReplaced;
  let preamblePending = isWorker && carriedReplaced;
  // The mode reaches the reviewer turn only. `readOnly` stays true there, so the mutation check
  // below still wraps the turn, and the orchestrator path never sets this input (ADR 0019, 0038).
  const sandbox = roleName === "reviewer" ? reviewerSandbox : null;

  const invokeRole = (finalPrompt) =>
    invoke({
      agents,
      state: role,
      roleName,
      prompt: finalPrompt,
      opts: {
        cwd,
        readOnly,
        ...(sandbox ? { sandbox } : {}),
        ...(onSessionAssigned ? { onSessionAssigned } : {}),
        timeout,
        signal,
      },
      onEvent,
      stepsUsed,
    });

  // A resume that fails because the CLI has no such session leaves the stored id useless, and
  // every later turn would fail the same way. Clear the id and rerun the turn once as a first
  // turn, so a worker gets its preamble again. The rerun belongs to the step already charged for
  // this turn: the failed resume ran no model turn, and the single rerun bounds the extra cost
  // (ADR 0016).
  const runTurn = async (finalPrompt) => {
    const resumedId = role.sessionId;
    try {
      return await invokeRole(finalPrompt);
    } catch (err) {
      if (!resumedId || !readProp(err, "sessionMissing")) {
        throw err;
      }
      logWarn(`${roleName}: session ${resumedId} is missing; rerunning the turn as a first turn`);
      role.sessionId = null;
      delete role.sessionUnconfirmed;
      return invokeRole(isWorker ? workerPrompt(prompt, true) : finalPrompt);
    }
  };

  // An adapter sets `conversationReplaced` when a resume ran the turn in a new conversation, so
  // that conversation never received the worker preamble. The turn already ran, so a rerun would
  // repeat its edits. A preamble-only turn in the new conversation gives it the preamble instead.
  // The turn that ran stays the result, so a failed preamble turn only warns (issue #396, ADR 0016).
  // The mark is cleared on every exit of `runChild` except a cancel that leaves the replaced
  // conversation without its preamble, so a step that throws after the adapter succeeded, such as
  // an event handler, leaves no stale mark for a later turn.
  const runFn = async (finalPrompt) => {
    const response = await runTurn(finalPrompt);
    preamblePending = false;
    if (role.conversationReplaced && isWorker) {
      delete role.conversationReplaced;
      preamblePending = true;
      try {
        await invokeRole(workerPrompt(PREAMBLE_ONLY_TASK, true));
        preamblePending = false;
      } catch (err) {
        if (readProp(err, "isCanceled")) {
          throw err;
        }
        logWarn(
          `worker: the preamble turn in the new conversation failed: ${firstErrorLine(readableErrorText(err))}`,
        );
      }
    }
    return response;
  };

  // The worker prompt needs no runtime read, so it is built once here. The
  // reviewer prompt is built inside the mutation check, where the pre-turn
  // snapshot gives the local head the status read compares against (#320).
  const workerFinalPrompt = isWorker
    ? workerPrompt(prompt, role.sessionId === null || carriedReplaced)
    : null;

  /**
   * Reads the required-check status a PR-bearing run supplies to the reviewer,
   * for the declared `--pr` or, when none is declared, the `--require-ci` PR
   * (#350), using the pre-turn snapshot head as the local head, and its `clean` flag so a
   * pass is withheld for a tree the finish gate refuses. A failed read, a
   * mismatched head, and a stalled read are all an unresolved status rather than
   * a turn failure, and the reviewer keeps its own read as the fallback
   * (issue #320). The status covers the PR head on GitHub, so it is evidence
   * for the reviewer, not a gate.
   */
  const readStatus = async ({ head, clean }) => {
    if (roleName !== "reviewer" || pr === null) {
      return null;
    }
    const status = await readRequiredChecks({ pr, cwd, head, clean, gh, timeoutMs: readTimeoutMs });
    logInfo(`runtime read the required checks for PR ${pr}: ${status.summary}`);
    return status;
  };

  // Declared outside the try so a turn that fails after the command ran still
  // reports what the runtime read and the work tree change it saw (ADR 0017).
  let testRun = null;
  let keepReplacedMark = false;
  try {
    let reviewed = null;
    let prChecks = null;
    // The command runs before the mutation check takes its baseline, so the
    // writes it makes are reported by the runner and are not a reviewer mutation.
    // The reviewed state below therefore describes the tree after the command
    // (ADR 0017). The command never fails the turn: a failed, timed-out, or
    // unstartable command is a result the reviewer receives.
    if (roleName === "reviewer" && testCmd) {
      testRun = await runTestCmd({ ...testCmd, cwd, signal });
    }
    const response = readOnly
      ? await withMutationCheck(
          cwd,
          roleName,
          async (before) => {
            // The reviewed state comes from the runtime snapshot, never from the
            // child response, so the child cannot misreport it.
            reviewed = reviewedState(before);
            if (testRun) reportLateChangedPaths(testRun, before);
            prChecks = await readStatus(reviewed);
            return runFn(reviewerPrompt(prompt, prChecks, testRun, sandbox));
          },
          { signal },
        )
      : await runFn(workerFinalPrompt);
    // A cancel can also land after the adapter returned, in the post-turn snapshot. Every result of
    // this function passes here, so no caller records a canceled turn as ok (#587).
    throwIfCanceled(signal, roleName);
    // An adapter sets `shellDenied` when the turn reported a refused tool call (ADR 0035).
    const shellDenied = role.shellDenied === true;
    return {
      role: roleName,
      status: "ok",
      response,
      ...(shellDenied ? { shellDenied } : {}),
      ...(reviewed ? { reviewed } : {}),
      ...(prChecks ? { prChecks } : {}),
      ...(testRun ? { testRun } : {}),
    };
  } catch (err) {
    const name = readProp(err, "name");
    const isCanceled = readProp(err, "isCanceled");
    if (name === "MutationError" || name === "SnapshotError" || isCanceled) {
      if (isCanceled) {
        logError(`${roleName} canceled by signal`);
        // The canceled turn keeps the id the CLI reported, so a replaced conversation, or one whose
        // preamble turn did not finish, keeps its mark for the next turn (ADR 0027, decision 5).
        keepReplacedMark = preamblePending || role.conversationReplaced === true;
        if (keepReplacedMark) role.conversationReplaced = true;
      }
      // A fatal error ends the turn, and the caller records it, so the result rides on it.
      // A cancel of the command itself already carries its own result.
      testRun ??= failedTestRun(err) ?? null;
      if (testRun && err && typeof err === "object") {
        carryTestRun(err, testRun);
      }
      throw err;
    }
    // The result carries text, so a non-string message is its JSON form.
    let errorMessage = readableErrorText(err);
    const timedOut = readProp(err, "timedOut");
    if (timedOut) {
      errorMessage = `${roleName} timed out after ${timeout} seconds`;
    }
    logWarn(timedOut ? errorMessage : `${roleName}: ${firstErrorLine(errorMessage)}`);
    return {
      role: roleName,
      status: "error",
      error: errorMessage,
      ...(testRun ? { testRun } : {}),
    };
  } finally {
    if (!keepReplacedMark) delete role.conversationReplaced;
    delete role.shellDenied;
  }
}
