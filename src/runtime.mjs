import { defaultAgents, runAgent } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { readableErrorText, readProp } from "./lib/error-message.mjs";
import { checkCi, DEFAULT_READ_TIMEOUT_MS, readRequiredChecks } from "./lib/ci-gate.mjs";
import { copyLocalFiles as copyIntoWorkTree } from "./lib/local-files.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { applyResult, matchingGate } from "./lib/continuation.mjs";
import { reviewedState, withMutationCheck } from "./lib/snapshot.mjs";
import { decide } from "./orchestrator.mjs";
import {
  carryTestRun,
  DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
  failedTestRun,
  runTestCmd,
} from "./lib/test-cmd.mjs";
import { initialPrompt, refusalPrompt, resultPrompt } from "./prompts/orchestrator.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

// Task of the preamble-only worker turn that follows a replaced conversation.
const PREAMBLE_ONLY_TASK =
  "No task this turn. Reply with the single word OK and change nothing. The rules above apply to every later turn.";

/**
 * Every CLI call goes through here. Emits one `invocation` event per call, carrying the
 * usage the adapter exposed on `state.usage`, and clears that field so it never lingers.
 */
async function invoke({ agents, state, roleName, prompt, opts, onEvent, stepsUsed }) {
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
 * Runs one read-only probe turn in a new session and reads `state.resolvedModel` from it (#394). The
 * probe is a child turn, so it runs under the same mutation check as a reviewer turn: a probe that
 * changes the work tree throws `MutationError`, a failed snapshot throws `SnapshotError`, and
 * `signal` cancels the CLI call. Every error is thrown, never returned as a result, because the
 * caller refuses the continuation on any failure.
 * @param {{ agents?: object, state: object, roleName: string, prompt?: string, cwd: string, timeout?: number | null, signal?: AbortSignal }} options
 */
export async function runProbeTurn({
  agents = defaultAgents,
  state,
  roleName,
  prompt = "Reply with the single word OK.",
  cwd,
  timeout,
  signal,
}) {
  await withMutationCheck(cwd, roleName, () =>
    invoke({
      agents,
      state,
      roleName,
      prompt,
      opts: { cwd, readOnly: true, timeout, signal },
      onEvent: () => {},
      stepsUsed: 0,
    }),
  );
  // A cancel can land in the post-turn snapshot, after the adapter returned (#587).
  throwIfCanceled(signal, roleName, state);
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
 * `reviewerWorkspaceWrite` passes the reviewer-only `sandbox: "workspace-write"` input to a
 * reviewer turn and adds the matching prompt line; no other role receives it (ADR 0019).
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
    reviewerWorkspaceWrite = false,
    onSessionAssigned,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const isWorker = roleName === "worker";
  const readOnly = !isWorker;
  const requestedSessionId = role.sessionId;
  // The opt-in reaches the reviewer turn only. `readOnly` stays true there, so the mutation check
  // below still wraps the turn, and the orchestrator path never sets this input (ADR 0019).
  const sandbox = roleName === "reviewer" && reviewerWorkspaceWrite ? "workspace-write" : null;

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
  // The mark is cleared on every exit of `runChild`, so a step that throws after the adapter
  // succeeded, such as an event handler, leaves no stale mark for a later turn.
  const runFn = async (finalPrompt) => {
    const response = await runTurn(finalPrompt);
    if (role.conversationReplaced && isWorker) {
      delete role.conversationReplaced;
      try {
        await invokeRole(workerPrompt(PREAMBLE_ONLY_TASK, true));
      } catch (err) {
        if (readProp(err, "isCanceled")) {
          throw err;
        }
        logWarn(
          `worker: the preamble turn in the new conversation failed: ${readableErrorText(err).split("\n")[0]}`,
        );
      }
    }
    return response;
  };

  // The worker prompt needs no runtime read, so it is built once here. The
  // reviewer prompt is built inside the mutation check, where the pre-turn
  // snapshot gives the local head the status read compares against (#320).
  const workerFinalPrompt = isWorker ? workerPrompt(prompt, role.sessionId === null) : null;

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
      ? await withMutationCheck(cwd, roleName, async (before) => {
          // The reviewed state comes from the runtime snapshot, never from the
          // child response, so the child cannot misreport it.
          if (roleName === "reviewer") {
            reviewed = reviewedState(before);
            prChecks = await readStatus(reviewed);
          }
          return runFn(
            isWorker
              ? workerFinalPrompt
              : reviewerPrompt(prompt, prChecks, testRun, sandbox !== null),
          );
        })
      : await runFn(workerFinalPrompt);
    // A cancel can also land after the adapter returned, in the post-turn snapshot. Every result of
    // this function passes here, so no caller records a canceled turn as ok (#587). A reviewer turn
    // that ran in a replaced conversation keeps the earlier id, as `runAgent` does for a cancel
    // before the adapter returns (ADR 0027).
    throwIfCanceled(
      signal,
      roleName,
      role,
      role.conversationReplaced ? requestedSessionId : undefined,
    );
    return {
      role: roleName,
      status: "ok",
      response,
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
    logWarn(timedOut ? errorMessage : `${roleName}: ${errorMessage.split("\n")[0]}`);
    return {
      role: roleName,
      status: "error",
      error: errorMessage,
      ...(testRun ? { testRun } : {}),
    };
  } finally {
    delete role.conversationReplaced;
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
 * neither `pr` nor `requireCi` behaves exactly as before (#302). A gate that
 * passes on a base branch with no required check verified the PR head, the clean
 * reviewed tree, and the merge state, and the run emits a `no-required-checks`
 * event, so a finish that verified no check never reads as one whose checks
 * passed (#336).
 *
 * With `mode`, the headless run names its loop policy with the same flag and the
 * same values the interactive path takes, and the prompt states that mode. A
 * `review-only` mode is a run that dispatches no worker, so the CLI refuses
 * `pr`, `requireAccept`, and `requireCi` before the run starts, and the loop
 * refuses a `run_worker` action at runtime, the guard the interactive path
 * applies to `--role worker`. That mode also refuses a `finish` until a reviewer
 * turn has completed, which is the outcome the mode exists to record. The
 * interactive path reaches that state without a rule, because its init dispatch
 * is itself the reviewer turn, so the headless loop supplies the one condition
 * the interactive path gets for free (#337).
 *
 * With `continued`, the run resumes the sessions of an earlier headless run. The
 * completion gate state is reset unless `earlierGate` (see `gateFromTranscript`)
 * is valid and the current work tree has the head and digest of its last
 * reviewer turn (#393). A reset counts the work as unreviewed, so a finish under
 * `requireAccept` needs a reviewer accept in this run (#362). A restore takes
 * `lastReviewed` from the current snapshot, never from the record.
 *
 * With `copyLocalFiles` (default true), the run first copies the untracked, ignored
 * local agent and environment files of the main work tree into a linked `cwd`,
 * before the first turn and the first snapshot, and emits one `local-files`
 * event with the copied and skipped path names (ADR 0018).
 * With `testCmd`, the runtime runs that command in `cwd` before each reviewer
 * turn and supplies the result to the reviewer prompt and the result event as
 * advisory `testRun` evidence; `testCmdTimeout` bounds one run in seconds
 * (ADR 0017).
 * With `reviewerWorkspaceWrite`, a Codex reviewer turn runs in the `workspace-write`
 * sandbox with network off, and the reviewer prompt says so. The orchestrator turns
 * and the worker turns are unchanged, and the mutation check still wraps every
 * reviewer turn (ADR 0019).
 * `onSessionAssigned(roleName, id)` is awaited for the orchestrator, worker, and reviewer when an
 * adapter pre-assigns a session id, before its CLI starts, and with `null` when the CLI rejected
 * the id. It does not change the role state. The caller records the id and its unconfirmed mark
 * (ADR 0016).
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
    testCmd: testCmdText = null,
    testCmdTimeout = null,
    reviewerWorkspaceWrite = false,
    mode = null,
    continued = false,
    earlierGate = null,
    copyLocalFiles = true,
    onSessionAssigned,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    onEvent = () => {},
  } = options;

  const { orchestrator, worker, reviewer } = roles;

  logInfo(`agent loop started (cwd: ${cwd}, maxSteps: ${maxSteps})`);

  // Before the first child spawn and the first snapshot, so the copied files are
  // present for every turn. They are ignored, so no snapshot lists them.
  if (copyLocalFiles) {
    const report = await copyIntoWorkTree(cwd);
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
      gate: { workerRan, reviewerRan, reviewerTurnDispatched, acceptedSinceWorker, lastReviewed },
    };
  }

  let stepsUsed = 0;
  // Completion gate state (#234). The headless loop has no mode: a worker turn
  // marks work mode and needs a later reviewer accept; no worker turn maps to
  // review-only and needs at least one reviewer report.
  // A continued run restores the earlier run's gate state only when it is valid
  // and the current work tree is the state that run's last reviewer turn
  // reviewed (#393). The CLI derives `earlierGate` from the result events of the
  // earlier transcript, never from a stored flag.
  // Otherwise it resets conservatively (#362): the tree counts as changed and
  // unreviewed, so a reviewer accept on the current state is what
  // `--require-accept` needs, and `reviewerRan`, `lastReviewed`, and the
  // review-only turn flag start empty, so every gate reads only this run.
  const restoredGate = continued ? await matchingGate(earlierGate, cwd) : null;
  let workerRan = restoredGate?.workerRan ?? continued;
  let reviewerRan = restoredGate?.reviewerRan ?? false;
  // A reviewer turn that was dispatched, whatever it returned. `reviewerRan`
  // counts only a turn that ended `ok`, because `--require-accept` reads that
  // one. A `review-only` run needs the turn itself, not a successful one: the
  // interactive path accepts its finish from `active` after any reviewer turn,
  // including one that ended in a handled error, and the summary records what
  // the turn returned (#337).
  let reviewerTurnDispatched = restoredGate?.reviewerTurnDispatched ?? false;
  let acceptedSinceWorker = restoredGate?.acceptedSinceWorker ?? false;
  let finishRefused = false;
  // The reviewed state the `--require-ci` gate reads: the runtime-owned identity
  // of the last reviewer turn, reset to none by any later turn, so a change made
  // after that review cannot be gated against the older head (#293). It mirrors
  // the interactive `lastResult.reviewed` the role gate reads.
  let lastReviewed = restoredGate?.lastReviewed ?? null;

  // The caller persists a pre-assigned id before the CLI starts, so a parent crash during a first
  // turn leaves it (issue #564). The role state is not touched here: the adapter owns it.
  const assignedHook = onSessionAssigned && ((roleName) => (id) => onSessionAssigned(roleName, id));

  const instructions = initialPrompt({
    task,
    maxSteps,
    requireAccept,
    pr,
    requireCi,
    testCmd: testCmdText !== null,
    reviewerWorkspaceWrite,
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
      const earlierSessionId = state.sessionId;
      const call = (text) => {
        const resumedUnconfirmed = state.sessionId !== null && state.sessionUnconfirmed === true;
        return withMutationCheck(cwd, "orchestrator", async () => {
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
            if (resumedUnconfirmed && readProp(err, "sessionMissing") && state.sessionId !== null) {
              state.sessionUnconfirmed = true;
            }
            throw err;
          }
        });
      };
      try {
        let response = await call(p);
        const replaced = Boolean(state.conversationReplaced);
        if (replaced && p !== instructions) {
          delete state.conversationReplaced;
          logWarn(
            "orchestrator: conversation was replaced; rerunning the turn with its instructions",
          );
          response = await call(
            `${instructions}\n\nThe conversation restarted and earlier turns are lost. Ignore the request above to choose a first action. Answer the prompt below.\n\n${p}`,
          );
        }
        // A cancel can land in the post-turn snapshot, after the adapter returned. The turn then
        // keeps the earlier id of a replaced conversation, as `runAgent` does (#587, ADR 0027).
        throwIfCanceled(
          opts.signal,
          "orchestrator",
          state,
          replaced ? earlierSessionId : undefined,
        );
        return response;
      } finally {
        delete state.conversationReplaced;
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
        logError(`orchestrator turn failed: ${readableErrorText(err).split("\n")[0]}`);
      }
      throw err;
    }

    onEvent({ type: "action", action, stepsUsed });

    if (action.action === "finish") {
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
      if (mode === "review-only" && !reviewerTurnDispatched) {
        needsChildTurn = true;
        refusals.push({
          reason: "no reviewer turn has run, and a review-only run dispatches no worker",
          recovery:
            "Dispatch the reviewer, then finish once that turn has returned. What the turn returned is what the finish records: the verdict, or the error, goes in verified, and neither blocks the finish.",
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
        const gate = await ciGate({ pr: requireCi, reviewed: lastReviewed, cwd, gh });
        if (gate.refusal) {
          // The gate reads the reviewed state, which only a reviewer turn
          // establishes, so a gate refusal always needs a child turn (#293).
          needsChildTurn = true;
          refusals.push(gate.refusal);
        } else {
          noRequiredChecks = gate.noRequiredChecks;
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
        cwd,
        timeout,
        signal,
        stepsUsed,
        // The declared PR, or the gated PR when none is declared, is known before
        // the turn and supplies the reviewer with the required-check status (#320,
        // #350). A run with neither reads nothing, and the reviewer keeps its own
        // read. The CLI refuses a `--pr` and a `--require-ci` that name different PRs.
        pr: pr ?? requireCi,
        // The command text comes from the `--test-cmd` run input only (ADR 0017).
        testCmd:
          testCmdText === null
            ? null
            : {
                command: testCmdText,
                timeoutSeconds: testCmdTimeout ?? DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
              },
        reviewerWorkspaceWrite,
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
    ({ workerRan, reviewerRan, reviewerTurnDispatched, acceptedSinceWorker, lastReviewed } =
      applyResult(
        { workerRan, reviewerRan, reviewerTurnDispatched, acceptedSinceWorker, lastReviewed },
        roleName,
        result,
      ));
    finishRefused = false;

    prompt = resultPrompt({ result, stepsUsed, maxSteps });
  }
}

// The review-only worker refusal, worded after the interactive `--role worker`
// guard it mirrors, so a parent reads one rule on both paths.
const REVIEW_ONLY_WORKER_REFUSAL = "mode review-only rejects a run_worker action";

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
    const detail = readableErrorText(err).split("\n")[0];
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
