import { defaultAgents } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { DEFAULT_MAX_STEPS } from "./lib/args.mjs";
import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import {
  COMPARE_HEAD_INPUT_REFUSAL,
  DEFAULT_READ_TIMEOUT_MS,
  unreadableGateReason,
  unreadableGateRefusal,
} from "./lib/ci-gate.mjs";
import { evaluateFinish, REVIEW_ONLY_WORKER_REFUSAL } from "./finish-gate.mjs";
import { copyLocalFiles as copyIntoWorkTree } from "./lib/local-files.mjs";
import { logError, logInfo, logWarn, logWarnFull } from "./lib/log.mjs";
import {
  applyResult,
  freshGate,
  matchingGate,
  refuseDeclaredPrConflict,
  resetGate,
} from "./lib/gate.mjs";
import { withMutationCheck } from "./lib/snapshot.mjs";
import { resolveWorkerPr } from "./lib/worker-pr.mjs";
import { failedTurnEvidence, invoke, pickTurnEvidence, runChild } from "./child-turn.mjs";
import { decide } from "./orchestrator.mjs";
import { testCmdInput } from "./lib/test-cmd.mjs";
import { initialPrompt, resultPrompt } from "./prompts/orchestrator.mjs";

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
 * Runs the orchestrator loop. Returns `{ exitCode: 0, summary, unresolvedCompare, gate }`, plus
 * `headCompare: "verified"` for a passing `compareHead` finish, when the orchestrator returns
 * `finish`. It returns `{ exitCode: 1 | 2, reason, gate }` on `abort`, a refused finish, a
 * refused `run_worker` in review-only mode, or a step limit reached with work remaining. `gate`
 * is the completion gate state, which the headless CLI records in the transcript for a later
 * `--continue-from`. Throws on fatal controller errors: orchestrator failure, detected mutation,
 * or cancel. A finish that records `unresolvedCompare` emits an `unresolved-compare` event and
 * reports `unresolvedCompare: true`, which the headless CLI maps to `UNRESOLVED_COMPARE_EXIT`
 * (#266, #279).
 *
 * Finish gates: `evaluateFinish` in `finish-gate.mjs` owns every condition, the refusal order, the
 * corrective-turn rule, and the events. A worker turn resets the reviewed state to none, and only
 * a reviewer turn establishes it, so after a worker turn the gates need a later reviewer turn.
 * - `requireCi`: the PR head must match the last reviewer turn's reviewed state and every required
 *   check must pass. A pass on a base branch with no required check emits `no-required-checks`.
 * - `compareHead`: the PR head must match the last reviewed state, for a repository whose
 *   required-check sources are unreadable. A pass emits `head-compare` and reports
 *   `headCompare: "verified"` (#1104).
 * - `pr`: the run declares its delivery PR, so a finish must pass `requireCi` for the same PR
 *   (#302).
 * - `requireAccept`: a finish needs a later reviewer accept with a Checks line after a worker
 *   turn, or at least one reviewer report with no worker turn.
 * - `mode: "review-only"`: a finish needs a completed reviewer turn, whatever it returned.
 *
 * `mode`: the loop policy, with the values of the interactive `--mode`. `review-only`
 * dispatches no worker, so the CLI refuses `pr`, `requireAccept`, and `requireCi`, and the loop
 * refuses a `run_worker` action (#337).
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
 * @returns {Promise<({ exitCode: 0, summary: object, unresolvedCompare: boolean, headCompare?: "verified" } | { exitCode: 1 | 2, reason: string }) & { gate: object }>}
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
    compareHead = null,
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

  const continuedPr = continued ? earlierPr : null;

  // A continued run keeps the PR that the earlier run declared. The CLI refuses a conflict first,
  // and this check holds for any other caller, before the first child spawn.
  refuseDeclaredPrConflict(continuedPr, { pr, requireCi, mode, compareHead });
  // The compare is for a run with no declared PR, because a declared PR ends through its gate. The
  // CLI refuses the flags first, and this check holds for any other caller (#1104).
  if (compareHead !== null && (pr !== null || requireCi !== null)) {
    throw new Error(COMPARE_HEAD_INPUT_REFUSAL);
  }

  // A declared PR whose required-check sources the gate cannot read could only end through `abort`,
  // so the start refuses it before any child spawn (#1092). A continued run that restored its PR
  // makes no read here: the earlier run read at its own start when it took `--pr`, or before it
  // declared a PR that a worker turn opened (#1097).
  const readAtStart = pr !== null && continuedPr === null;
  if (readAtStart) {
    const unreadable = await unreadableGateReason({
      pr,
      cwd,
      gh,
      timeoutMs: readTimeoutMs,
      signal,
    });
    if (unreadable) {
      throw new Error(unreadableGateRefusal(`--pr ${pr}`, unreadable));
    }
  }

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
    const marker = detail.unresolvedCompare
      ? ", unresolved compare recorded"
      : detail.headCompare
        ? ", head compare verified"
        : "";
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
  const restoredPr = pr === null && requireCi === null ? continuedPr : null;
  let declaredPr = pr ?? restoredPr;
  // The PR that a worker turn opened and the runtime refused to declare, because the required-check
  // sources are unreadable (#1097). The finish compares its head with the reviewed commit, as
  // `--compare-head` does (ADR 0052, #1111). A continuation does not restore it: it takes the PR of a
  // `pr-declared` record only, so a continuation resolves it again after its own worker turn.
  let undeclaredPr = null;
  // The PR that the finish gate checks: `--require-ci`, or the PR that the runtime declared. A PR
  // that only `--pr` names has no gate, because that flag is a child-free run input that carries
  // none. A PR that the runtime resolved is not an operator input and no child chose it, so the
  // gate applies to it (ADR 0045).
  let gatedPr = requireCi ?? continuedPr;
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
    requireCi: gatedPr,
    compareHead,
    testCmd: testCmdText !== null,
    reviewerSandbox: sandboxMode,
    mode,
    continued,
    startRead: readAtStart,
    gateRestored: restoredGate !== null,
    timeout,
    cwd,
    orchestratorKind: orchestrator?.kind ?? null,
    reviewerKind: reviewer?.kind ?? null,
  });

  const orchAdapter = createOrchestratorAdapter({
    agents,
    cwd,
    instructions,
    assignedHook,
    onEvent,
    getStepsUsed: () => stepsUsed,
  });

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
        requireCi: gatedPr,
        compareHead: compareHead ?? undeclaredPr,
        compareFlag: compareHead !== null,
        gate,
        finishRefused,
        stepsUsed,
        maxSteps,
        cwd,
        gh,
        signal,
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
      const { testRun, inheritedTmpdirEntries, packageStoreEntries } = pickTurnEvidence(
        failedTurnEvidence(err),
      );
      if (testRun) {
        onEvent({ type: "test-run", role: roleName, testRun, fatal: true, stepsUsed });
      }
      if (inheritedTmpdirEntries) {
        onEvent({
          type: "inherited-tmpdir",
          role: roleName,
          entries: inheritedTmpdirEntries,
          fatal: true,
          stepsUsed,
        });
      }
      if (packageStoreEntries) {
        onEvent({
          type: "package-store",
          role: roleName,
          entries: packageStoreEntries,
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
    let newlyUndeclared = null;
    if (isWorkerDispatch && declaredPr === null && requireCi === null && compareHead === null) {
      const resolved = await declareWorkerPr({ result, cwd, gh, signal, readTimeoutMs });
      newlyDeclared = resolved.pr;
      if (newlyDeclared !== null) {
        declaredPr = newlyDeclared;
        gatedPr = newlyDeclared;
        undeclaredPr = null;
        onEvent({ type: "pr-declared", pr: declaredPr, stepsUsed });
      } else if (resolved.undeclaredPr !== null) {
        // A later worker turn can refuse another PR, and the latest one is the PR to compare.
        // An earlier undeclared PR stays the compare target when a later turn names none. The
        // compare reads the PR state, so a PR that is closed or merged refuses the finish.
        undeclaredPr = newlyUndeclared = resolved.undeclaredPr;
        onEvent({ type: "pr-undeclared", pr: undeclaredPr, stepsUsed });
      }
    }

    prompt = resultPrompt({
      result,
      stepsUsed,
      maxSteps,
      declaredPr: newlyDeclared,
      undeclaredPr: newlyUndeclared,
    });
  }
}

/**
 * Builds the adapter that runs each orchestrator turn under the mutation check.
 * `getStepsUsed` is read at each call, because the loop advances the count between turns.
 * `assignedHook` is the `onSessionAssigned` wrapper of the loop, or a falsy value when the caller
 * records no session id.
 *
 * An adapter sets `conversationReplaced` when a resume ran the turn in a new conversation, which
 * never received `instructions`. The turn is read-only, so a rerun repeats no edit: it carries the
 * instructions before the same prompt, and its answer replaces the one the instructionless
 * conversation gave. Each call has its own mutation check, so an edit of the first call is
 * detected before the rerun can restore it. The earlier turns of the old conversation are lost.
 * One rerun only, and the mark is cleared on every exit (issue #396, ADR 0016).
 * @param {object} options
 */
function createOrchestratorAdapter({
  agents,
  cwd,
  instructions,
  assignedHook,
  onEvent,
  getStepsUsed,
}) {
  return {
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
                stepsUsed: getStepsUsed(),
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
}

/**
 * Resolves the PR that a worker turn opened, for a run with no PR input (ADR 0043). The head
 * compared is the work tree head that the runtime read after the turn, never a child report.
 * Returns `pr`, the PR number or null when the run stays undeclared, and `undeclaredPr`, the PR that
 * the runtime refused to declare because its required-check sources are unreadable (#1097), or null.
 * That PR gets the head compare at finish (#1111). A refusal to name one PR is logged as a
 * warning, except for no PR at all, which is the usual state of a task with no PR.
 * @returns {Promise<{ pr: number | null, undeclaredPr: number | null }>}
 */
async function declareWorkerPr({ result, cwd, gh, signal, readTimeoutMs }) {
  if (result.status !== "ok") return { pr: null, undeclaredPr: null };
  const resolved = await resolveWorkerPr({
    cwd,
    head: result.workTree?.head ?? null,
    gh,
    signal,
    timeoutMs: readTimeoutMs,
    // The same read as the start of a `--pr` run (#1092): a declared PR whose gate cannot read the
    // required-check sources could only end through `abort`, so the run stays undeclared (#1097).
    // The resolver runs it before its final identity check, so a head, branch, or remote that
    // moves during it leaves the run undeclared too (ADR 0043).
    confirm: async (pr) => {
      const unreadable = await unreadableGateReason({
        pr,
        cwd,
        gh,
        timeoutMs: readTimeoutMs,
        when: "before declaring it",
        signal,
      });
      return unreadable
        ? `PR ${pr} is not declared, because ${unreadable}, so the --require-ci gate would refuse every finish. The runtime compares the PR head with the reviewed commit at finish instead (head compare), reads no required-check source, and claims no check result.`
        : null;
    },
  });
  if (resolved.pr === null) {
    if (resolved.quiet) return { pr: null, undeclaredPr: null };
    // A trusted reason names no untrusted text, so the recovery stays whole.
    (resolved.trusted ? logWarnFull : logWarn)(
      `no PR declared after the worker turn: ${resolved.reason}`,
    );
    return { pr: null, undeclaredPr: resolved.undeclaredPr ?? null };
  }
  logInfo(`runtime declared PR ${resolved.pr} after the worker turn`);
  return { pr: resolved.pr, undeclaredPr: null };
}
