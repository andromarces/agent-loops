// `agent-loop role dispatch`: initializes the run on the first call. It then charges one step and
// runs one child turn under the state lock, recording the result in the state file.
import { appendFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeAgent } from "../agents/index.mjs";
import { throwIfCanceled } from "../agents/shared.mjs";
import { DEFAULT_MAX_STEPS, DEFAULT_TIMEOUT, readTaskFile, roleState } from "../lib/args.mjs";
import { refuseHeldIds, refuseHeldSessions } from "../lib/command-line.mjs";
import { MAX_ENTRIES, reportedPathNames } from "../lib/evidence/entry-report.mjs";
import { readableErrorMessage, redactedText, readProp } from "../lib/error-message.mjs";
import { sha256 } from "../lib/hash.mjs";
import { findLocalFileChanges, hashCopiedLocalFiles } from "../lib/local-file-changes.mjs";
import { copyLocalFiles, locateLocalFiles } from "../lib/local-files.mjs";
import { logInfo, logWarn, logWarnFull } from "../lib/log.mjs";
import { processStartTime } from "../lib/process-identity.mjs";
import { redactAndClean } from "../lib/redact.mjs";
import { parseVerdict } from "../lib/report.mjs";
import {
  TERMINAL_LIFECYCLES,
  readClaudeSessions,
  readState,
  statePaths,
  writeSessionEntry,
  writeState,
} from "../lib/runstate.mjs";
import { assertGitWorkTree } from "../lib/snapshot.mjs";
import { readSparseCheckout } from "../lib/sparse-checkout.mjs";
import { withStateLock } from "../lib/state-lock.mjs";
import { DEFAULT_TEST_CMD_TIMEOUT_SECONDS, testCmdInput } from "../lib/test-cmd.mjs";
import { removeAbandonedTurnTmpdir, recheckKeptTurnTmpdir } from "../lib/turn-tmpdir.mjs";
import { readWorkTreePr } from "../lib/work-tree-pr.mjs";
import { runChild } from "../child-turn.mjs";
import {
  carryTurnEvidence,
  failedTurnEvidence,
  turnResultFields,
  TURN_EVIDENCE_FIELDS,
} from "../lib/evidence/turn-evidence.mjs";
import {
  normalizedLocalPaths,
  rejectInitFlagChanges,
  rejectMisplacedFlags,
  storedReviewerSandbox,
  validateInitFlags,
} from "./args.mjs";
import { RoleError } from "./envelope.mjs";
import {
  acquireWorkTreeLock,
  readStdin,
  refuseUnreadableGate,
  releaseWorkTreeLock,
  requireState,
} from "./state.mjs";

/**
 * Init detection is keyed on `--task` alone: the first call carries the task.
 * Later calls read the configuration from the state file. A provided flag
 * that matches the state passes through, and a changed one is rejected.
 */
function isInitCall(args) {
  return args.task !== null;
}

function initialState(args) {
  return {
    task: args.task,
    mode: args.mode ?? "work-first",
    cwd: args.cwd,
    parentSession: args.parentSession,
    maxSteps: args.maxSteps ?? DEFAULT_MAX_STEPS,
    timeout: args.timeoutProvided ? args.timeout : DEFAULT_TIMEOUT,
    stepsUsed: 0,
    lifecycle: "active",
    pr: args.pr,
    copyLocalFiles: !args.noCopyLocalFiles,
    // Operator paths that join the copy, kept so the run records what it asked for.
    ...(args.copyLocalPaths.length > 0 ? { copyLocalPaths: normalizedLocalPaths(args) } : {}),
    // The mode of a Codex reviewer, `none` by default. A reviewer that is not Codex has none, so its
    // state keeps the earlier shape (ADR 0038).
    ...(args.reviewer !== null && normalizeAgent(args.reviewer) === "codex"
      ? { reviewerSandbox: args.reviewerSandbox ?? "none" }
      : {}),
    // The state file holds a digest of the command and never the command. The
    // flag on each reviewer dispatch is the only source of what runs. The
    // digest only detects a changed flag (ADR 0017). A run with no command
    // carries neither field.
    ...(args.testCmd === null
      ? {}
      : {
          testCmdSha256: sha256(args.testCmd),
          testCmdTimeout: args.testCmdTimeout ?? DEFAULT_TEST_CMD_TIMEOUT_SECONDS,
        }),
    roles: {
      worker: roleState(args, "worker"),
      reviewer: roleState(args, "reviewer"),
    },
    lastDispatch: null,
    lastResult: null,
    turns: [],
    // Marks a history that this version recorded from the run's first turn. A state written before
    // `turns` existed lacks the mark, so it never refunds a refusal (issue #1565).
    turnsComplete: true,
  };
}

/**
 * Archives a terminal state file as `state.<timestamp>.json` so a new run can
 * take its place. Absence is a no-op. Called only after every init check and
 * the prompt read pass, so a rejected init archives nothing (#123).
 */
async function archiveState(paths, existing) {
  if (!existing) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = join(dirname(paths.stateFile), `state.${stamp}.json`);
  await rename(paths.stateFile, archived);
  logInfo(`archived terminal state file to ${archived}`);
}

async function readPrompt(args, stdin) {
  const text = args.promptFile ? await readFile(args.promptFile, "utf8") : await stdin();
  if (text.trim() === "") {
    throw new RoleError(
      args.promptFile
        ? `Prompt file is empty: ${args.promptFile}`
        : "Prompt on stdin is empty. Pipe a prompt or use --prompt-file.",
    );
  }
  return text;
}

function createEventSink(transcriptFile) {
  const events = [];
  const onEvent = (event) => {
    if (transcriptFile) {
      // Stamped at emit time, like the headless transcript.
      events.push({ ...event, at: new Date().toISOString() });
    }
  };
  // Appends once per invocation so a process exit cannot lose the events.
  onEvent.flush = async () => {
    if (!transcriptFile || events.length === 0) {
      return;
    }
    const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    try {
      await appendFile(transcriptFile, text, "utf8");
    } catch (err) {
      // Transcript failures must not change the command outcome.
      logWarnFull(
        redactedText(
          `Failed to append transcript to ${transcriptFile}: ${redactedText(readProp(err, "message"))}`,
        ),
      );
    }
    events.length = 0;
  };
  return onEvent;
}

/**
 * Dispatch operation: initialize on the first call, then charge the step,
 * mark `dispatched`, run exactly one child turn, and record the result.
 */
export async function dispatch(
  args,
  { agents, stdin = readStdin, signal, gh, readProcessCommands, onMainWatch, mainWatchDeadlineMs },
) {
  if (!args.role) {
    throw new RoleError("dispatch requires --role worker or reviewer.");
  }
  rejectMisplacedFlags(args, "dispatch");

  // The task file becomes `--task`, so init detection and the init checks see one source.
  if (args.taskFile !== null) {
    // Stdin holds one input, so a task on stdin leaves the prompt to --prompt-file.
    if (args.taskFile === "-" && !args.promptFile) {
      throw new RoleError(
        "--task-file - reads stdin, which the prompt also uses. Pass --prompt-file.",
      );
    }
    args.task = await readTaskFile(args.taskFile, () => stdin());
  }

  await assertGitWorkTree(args.cwd, { signal });
  const paths = statePaths({ cwd: args.cwd, parentSession: args.parentSession || undefined });
  const onEvent = createEventSink(args.transcript);

  try {
    return await withStateLock(paths.lockFile, () =>
      dispatchLocked(args, {
        agents,
        stdin,
        signal,
        paths,
        onEvent,
        gh,
        readProcessCommands,
        onMainWatch,
        mainWatchDeadlineMs,
      }),
    );
  } finally {
    await onEvent.flush();
  }
}

async function dispatchLocked(
  args,
  {
    agents,
    stdin,
    signal,
    paths,
    onEvent,
    gh,
    readProcessCommands,
    onMainWatch,
    mainWatchDeadlineMs,
  },
) {
  const existing = await readState(paths.stateFile);
  const init = isInitCall(args);
  let state;

  if (init) {
    // New-run rule: init over a terminal or absent state file is allowed. Init
    // over a non-terminal lifecycle is rejected, and the parent must abort it
    // first. Nothing is archived or written until every init check and the
    // prompt read pass, so a rejected init leaves the previous state untouched.
    validateInitFlags(args, agents);
    if (existing && !TERMINAL_LIFECYCLES.has(existing.lifecycle)) {
      throw new RoleError(
        `Existing run is ${existing.lifecycle}; abort it before starting a new run.`,
      );
    }
    if (args.pr !== null) {
      await refuseUnreadableGate(`--pr ${args.pr}`, { pr: args.pr, cwd: args.cwd, gh, signal });
    }
    // Init over a terminal run replaces its record, so re-check a turn directory that the ended run
    // kept. Do this before the new state drops the record (issue #1329).
    await recheckKeptTurnTmpdir(existing?.lastDispatch?.turnTmpdir);
    state = initialState(args);
  } else {
    state = requireState(existing, args.cwd, { needsBudget: true });
    rejectInitFlagChanges(args, state);
  }

  const roleName = args.role;

  // The flag is the only source of the command, on every dispatch, a resume
  // included. A reviewer dispatch of a run that set one must pass it again.
  // The refusal comes before the step is charged (ADR 0017).
  if (!init && roleName === "reviewer" && state.testCmdSha256 && args.testCmd === null) {
    throw new RoleError(
      "--test-cmd is required on every reviewer dispatch of a run that set it at init. Pass the same value: the state file holds only a digest of it.",
    );
  }

  // Hard guard that survives compaction and restart: review-only never runs the worker.
  if (state.mode === "review-only" && roleName === "worker") {
    throw new RoleError("mode review-only rejects --role worker.");
  }

  await recoverLifecycle(state, args, { paths, signal, readProcessCommands });

  if (state.stepsUsed >= state.maxSteps) {
    throw new RoleError(`Step budget exhausted (${state.stepsUsed}/${state.maxSteps}).`);
  }

  const prompt = await readPrompt(args, stdin);

  const localFiles = init
    ? await applyInitSideEffects(state, existing, args, {
        paths,
        signal,
        onEvent,
        readProcessCommands,
      })
    : null;
  const localFilesDiffer = init ? [] : await differingLocalFiles(state, args.cwd, signal);
  // Read after the init side effects, before the first child turn, and never change the setting.
  const sparseCheckout = init ? await readSparseCheckout(args.cwd) : null;

  // The turn history names a first turn of the role. A refunded first-turn refusal still records
  // its entry, so a later refusal charges a step (issue #1565).
  const firstRoleTurn = isFirstRoleTurn(state, roleName);

  // Charge the step before execution, matching the headless runtime.
  state.stepsUsed += 1;
  state.lifecycle = "dispatched";
  state.lastDispatch = { role: roleName, prompt, at: new Date().toISOString() };
  await writeState(paths.stateFile, state);

  const role = { ...state.roles[roleName] };
  let result;
  try {
    result = await runChild({
      agents,
      role,
      roleName,
      prompt,
      task: state.task ?? null,
      cwd: args.cwd,
      timeout: state.timeout,
      signal,
      stepsUsed: state.stepsUsed,
      // The declared PR is the run's PR input, so a reviewer turn supplies the
      // required-check status the runtime read (#320). A run that declares no PR
      // reads nothing, and the reviewer keeps its own read.
      pr: state.pr ?? null,
      reviewerSandbox: storedReviewerSandbox(state),
      // The copied local paths that the turn window hashes. An absent list reads no source.
      localFilesCopied: state.localFilesCopied ?? [],
      // A pre-assigned session id is written before the CLI starts. A crash during the turn
      // still leaves the id for the resume after `--resume-interrupted` (issue #395). The
      // result write below replaces it, with null when the turn kept no id.
      onSessionAssigned: async (id) => {
        recordRoleSession(state.roles[roleName], { sessionId: id, ...pickUnconfirmed(role, id) });
        await writeState(paths.stateFile, state);
      },
      // The record of the private turn directory is written before the CLI starts. A dispatch
      // that dies mid-turn leaves it for the call that marks the run `interrupted` (issue #1207).
      // The write is a precondition of the spawn: a failure starts no child and removes the turn
      // directory. `runChild` then handles it as any failed turn, so the run returns to `active`
      // with the step charged and an error result.
      onTurnTmpdir: async (record) => {
        state.lastDispatch.turnTmpdir = record;
        try {
          await writeState(paths.stateFile, state);
        } catch (err) {
          // The turn directory is removed on this failure, so no later write can save its record.
          delete state.lastDispatch.turnTmpdir;
          throw err;
        }
      },
      // The child pid and start time go in after the spawn. The recovery can then tell a dead turn
      // from a dispatcher killed while its child still runs. A failed write leaves the record
      // without a child, and the recovery then keeps the directory.
      onTurnChild: async (pid) => {
        const turnTmpdir = state.lastDispatch.turnTmpdir;
        if (!turnTmpdir) return;
        turnTmpdir.child = { pid, startTime: (await processStartTime(pid)) ?? undefined };
        await writeState(paths.stateFile, state);
      },
      ...(onMainWatch ? { onMainWatch } : {}),
      ...(mainWatchDeadlineMs === undefined ? {} : { mainWatchDeadlineMs }),
      // The command is the flag value, which init stored a digest of or the digest
      // check above matched. Nothing the state file holds is run.
      testCmd: testCmdInput(
        args.testCmd,
        Number.isSafeInteger(state.testCmdTimeout) ? Math.max(1, state.testCmdTimeout) : undefined,
      ),
      gh,
      onEvent,
    });
    // A worker envelope carries the open PR of the run branch beside the work tree state. Only a
    // caller that injects `gh` reads it, and a failed read or no match adds no field. A cancel
    // reaches the catch below, which records the interrupted lifecycle and exit 130.
    if (
      roleName === "worker" &&
      result.status === "ok" &&
      result.workTree &&
      typeof gh === "function"
    ) {
      const pr = await readWorkTreePr({ cwd: args.cwd, gh, signal });
      if (pr) {
        result = { ...result, workTree: { ...result.workTree, pr } };
      }
      // A cancel during the read follows the cancel path at the end of the child turn. The error
      // carries the evidence that the turn already read, so the catch below reports it too.
      try {
        throwIfCanceled(signal, roleName);
      } catch (err) {
        carryTurnEvidence(err, result);
        throw err;
      }
    }
  } catch (err) {
    const canceled = Boolean(readProp(err, "isCanceled"));
    const refusedModel = readProp(err, "refusedModel");
    const payload = dispatchPayload(roleName, {
      status: "error",
      error: readableErrorMessage(err),
      ...(typeof refusedModel === "string" ? { refusedModel } : {}),
      ...failedTurnEvidence(err),
    });
    if (firstRoleTurn && typeof refusedModel === "string") {
      refundModelRefusalStep(state, roleName);
    }
    // A cancel or a fatal guard error can end the turn after the CLI reported its session.
    // Keep the id for the resume that follows. A null id records a session the fallback cleared.
    await recordResult(state, roleName, role, payload, {
      lifecycle: canceled ? "interrupted" : "halted",
      stateFile: paths.stateFile,
      onEvent,
    });
    // Only a terminal lifecycle drops the work tree lock; an interrupted run keeps it.
    if (!canceled) {
      await releaseWorkTreeLock(args.cwd, { signal });
    }
    return {
      exitCode: canceled ? 130 : 1,
      payload: withSparseCheckout(
        withLocalFiles(payload, localFiles, localFilesDiffer),
        sparseCheckout,
      ),
    };
  }

  if (firstRoleTurn && result.status === "error" && typeof result.refusedModel === "string") {
    refundModelRefusalStep(state, roleName);
  }

  await recordResult(state, roleName, role, result, {
    lifecycle: "active",
    stateFile: paths.stateFile,
    onEvent,
  });

  // The dispatch itself succeeded, but a child error result is still a
  // non-zero command outcome for the calling parent.
  return {
    exitCode: result.status === "ok" ? 0 : 1,
    payload: withSparseCheckout(
      withLocalFiles(dispatchPayload(roleName, result), localFiles, localFilesDiffer),
      sparseCheckout,
    ),
  };
}

/**
 * True when the run marks its turn history complete from its first turn, and the history holds no
 * earlier turn of the role. A state written before `turns` existed has no mark, so it never
 * refunds a refusal, now or after a later write recreates part of the history (issue #1565).
 */
function isFirstRoleTurn(state, roleName) {
  return (
    state.turnsComplete === true &&
    Array.isArray(state.turns) &&
    !state.turns.some((turn) => turn.role === roleName)
  );
}

/**
 * Refunds the step charged for a first turn that a recognized model refusal ended, so the parent
 * can repair the model with `role set-model` and dispatch again inside the same budget (issue
 * #1565). The turn still records its entry, so a later refusal charges a step.
 */
function refundModelRefusalStep(state, roleName) {
  state.stepsUsed = Math.max(0, state.stepsUsed - 1);
  logInfo(
    `${roleName}: the first turn failed on a model refusal, so it charged no step (${state.stepsUsed} steps used)`,
  );
}

/**
 * Records the result of one dispatched turn: the lifecycle, `lastResult`, the turn history, and the
 * role session. It then writes the state and emits the `result` event.
 */
async function recordResult(state, roleName, role, result, { lifecycle, stateFile, onEvent }) {
  state.lifecycle = lifecycle;
  const at = new Date().toISOString();
  state.lastResult = { ...result, at };
  recordTurn(state, roleName, result, at);
  recordRoleSession(state.roles[roleName], role);
  await writeState(stateFile, state);
  onEvent({ type: "result", role: roleName, result, stepsUsed: state.stepsUsed });
}

/**
 * Applies the lifecycle rules of a dispatch to the run state. It refuses a terminal run and an
 * interrupted run without `--resume-interrupted`. It records the resume decision and marks a run
 * that ended uncertainly `interrupted`, writing the state before it throws.
 */
async function recoverLifecycle(state, args, { paths, signal, readProcessCommands }) {
  const roleName = args.role;
  if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
    throw new RoleError(`Run is ${state.lifecycle}; no further dispatch is possible.`);
  }

  if (state.lifecycle === "interrupted") {
    // Every later call re-checks the turn directory that the interrupted mark kept. The mark kept
    // it while a process of the dead child group ran. The call removes it once that group has
    // ended (issue #1329).
    await recheckKeptTurnTmpdir(state.lastDispatch?.turnTmpdir);
    if (!args.resumeInterrupted) {
      throw new RoleError(
        "Previous turn is interrupted. Use abort, or dispatch --resume-interrupted to continue.",
      );
    }
    // A hard kill of the dispatch leaves its claude child running, and the CLI accepts a resume of
    // that session. The check comes before the step is charged (#671, ADR 0031).
    await refuseHeldSessions(
      { [roleName]: state.roles[roleName] },
      { signal, flag: "--resume-interrupted", readProcessCommands },
    );
    state.resumeDecision = { at: new Date().toISOString() };
  } else if (state.lifecycle === "dispatched") {
    // A live lock owner makes `withStateLock` throw, so the previous
    // turn ended uncertainly. The first call after the crash always marks
    // `interrupted`, exits non-zero, and spawns no child. A maintainer can
    // resume from `interrupted` on a later call.
    state.lifecycle = "interrupted";
    // The previous call charged a step and recorded no result for it, so the
    // history is missing that turn. Record it here, marked `interrupted`: no
    // child ran, so there is no verdict and no reviewed head to record. Role
    // and time come from that turn's `lastDispatch`, because this call's
    // `--role` need not be the role that ended uncertainly (#312).
    await recordUncertainTurn(state, roleName);
    await writeState(paths.stateFile, state);
    throw new RoleError(
      "Previous turn ended uncertainly; state marked interrupted. Use abort, or dispatch --resume-interrupted to continue.",
    );
  }
}

/**
 * Runs the side effects of an init dispatch after every check and the prompt read passed. The steps
 * are the session holder check, the local file copy, the archive of the old state, and the first
 * state write. Returns the local file copy result, or null when none ran.
 */
async function applyInitSideEffects(
  state,
  existing,
  args,
  { paths, signal, onEvent, readProcessCommands },
) {
  let localFiles = null;
  // A hard kill of an earlier run can leave its `claude` child alive and writing to this work
  // tree. A live holder of a session that the earlier states recorded refuses the init (ADR 0032).
  await refuseHeldIds(await readClaudeSessions(paths.stateDir), {
    readProcessCommands,
    signal,
    label: "init",
  });
  // Every check and the prompt read passed. The copy comes first, before the
  // state file exists. A copy that throws leaves no run to abort. The copy also
  // comes before the first child turn and snapshot, so every turn sees the files.
  if (state.copyLocalFiles) {
    const located = await locateLocalFiles(args.cwd, { signal });
    localFiles = await copyLocalFiles(
      args.cwd,
      {},
      { signal, extraPaths: state.copyLocalPaths ?? [], located },
    );
    if (localFiles) {
      // Names only, so a later dispatch can compare each copy with its source. The stored hash of
      // each copy stays in the state file and never reaches an envelope or a log line.
      state.localFilesCopied = localFiles.copied;
      try {
        state.localFilesCopiedSha256 = await hashCopiedLocalFiles(args.cwd, localFiles.copied, {
          signal,
          located,
        });
      } catch (err) {
        if (readProp(err, "isCanceled")) {
          throw err;
        }
        // A present but empty map fails closed for every later compare.
        state.localFilesCopiedSha256 = {};
        logWarn(`local files: the stored hash could not be recorded (${err.code ?? "error"})`);
      }
      onEvent({ type: "local-files", ...localFiles });
    }
  }
  // Now archive the old terminal state file, if any, and write the new one.
  await archiveState(paths, existing);
  await writeState(paths.stateFile, state);
  if (args.parentSession) {
    await writeSessionEntry(paths.sessionEntryFile, paths.stateFile);
  }
  // The state file now names an active run, so the work tree holds its lock from here on.
  await acquireWorkTreeLock(args.cwd, { signal });
  logInfo(`initialized run state (mode: ${state.mode}, maxSteps: ${state.maxSteps})`);
  return localFiles;
}

/** The unconfirmed mark that goes with `id`: only a non-null id the adapter marked carries it. */
function pickUnconfirmed(role, id) {
  return id && role.sessionUnconfirmed ? { sessionUnconfirmed: true } : {};
}

/**
 * Copies the session id of a role copy to the role state. `sessionUnconfirmed` marks an id that
 * no CLI output has confirmed, so recovery verifies it before a resume (issue #395, ADR 0016).
 * `conversationReplaced` is set only by a canceled turn that ran in a replaced conversation.
 * The next worker turn then sends the preamble (ADR 0027, decision 5). `taskSentTo` is the session
 * id of the conversation that last carried the init task, so no path needs its own mark for it.
 */
function recordRoleSession(target, source) {
  target.sessionId = source.sessionId;
  if (source.sessionUnconfirmed) {
    target.sessionUnconfirmed = true;
  } else {
    delete target.sessionUnconfirmed;
  }
  if (source.conversationReplaced) {
    target.conversationReplaced = true;
  } else {
    delete target.conversationReplaced;
  }
  // Absent in the id-only copy that the session hook passes, so only a present value is recorded.
  if (typeof source.taskSentTo === "string") {
    target.taskSentTo = source.taskSentTo;
  }
}

/**
 * Names the copied local files whose source or copy differs from the stored hash. Read-only: nothing
 * is replaced. A failed comparison is a warning, not a failed dispatch, and fails closed: every
 * copied name is reported as `unknown`. A cancel propagates.
 */
async function differingLocalFiles(state, cwd, signal) {
  if (!state.copyLocalFiles || !state.localFilesCopied?.length) {
    return [];
  }
  try {
    return await findLocalFileChanges(cwd, state.localFilesCopied, state.localFilesCopiedSha256, {
      signal,
    });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      throw err;
    }
    logWarn(`local files: the comparison with the main work tree failed (${err.code ?? "error"})`);
    return state.localFilesCopied.map((path) => ({ path: String(path), changed: "unknown" }));
  }
}

/** Redacts and caps the side-aware entries, the same as the other path fields. */
function reportedLocalFileChanges(changes) {
  return changes
    .map((entry) => ({ path: redactAndClean(String(entry.path)), changed: entry.changed }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_ENTRIES);
}

/**
 * Adds the copied and skipped path names of the init copy to the envelope. On a later dispatch it
 * adds the names and sides of copies that differ from the stored hash.
 */
function withLocalFiles(payload, localFiles, localFilesDiffer) {
  return {
    ...payload,
    ...(localFiles ? { localFiles } : {}),
    ...(localFilesDiffer.length > 0
      ? { localFilesDiffer: reportedLocalFileChanges(localFilesDiffer) }
      : {}),
  };
}

/**
 * Adds the sparse checkout that a linked `--cwd` inherits to the init envelope. The paths are
 * redacted and capped like the other path fields. A null read adds no field, and the absent field
 * then proves nothing, because a failed read adds none either.
 */
function withSparseCheckout(payload, sparseCheckout) {
  if (sparseCheckout === null) return payload;
  return {
    ...payload,
    sparseCheckout: {
      enabled: sparseCheckout.enabled,
      skipWorktree: reportedPathNames(sparseCheckout.skipWorktree),
    },
  };
}

/**
 * Records the charged turn that a dead dispatch left unrecorded and removes the turn directory that
 * it kept. `fallbackRole` names the role when the record holds none. The lock owner is dead, so no
 * child of that turn writes into its turn directory (#1207). The removal keeps the directory while
 * a process of the dead child may still run, and warns instead of throwing (ADR 0058, ADR 0063).
 * The caller writes the state.
 */
export async function recordUncertainTurn(state, fallbackRole = "worker") {
  await removeAbandonedTurnTmpdir(state.lastDispatch?.turnTmpdir);
  recordTurn(
    state,
    state.lastDispatch?.role ?? fallbackRole,
    { status: "interrupted" },
    state.lastDispatch?.at ?? new Date().toISOString(),
  );
}

/**
 * Appends one turn entry to `turns`, which survives every later overwrite of
 * `lastDispatch` and `lastResult`. The entry records the turn's identity, not
 * its text: `role`, `status`, `verdict`, the reviewed `head`, and `at`. Report
 * and response text stay out of it, so the state file cannot grow with the text
 * a child returns (#312).
 *
 * Exactly one entry exists per dispatched turn. A first turn that a recognized model refusal ends
 * charges no step but still records one, so a later refusal charges a step (issue #1565). An entry
 * is written when a dispatch records its result, when a child fails, or when recovery records a
 * crash's uncertain turn. A dispatch past `maxSteps` is refused before it runs, so the array holds
 * at most `maxSteps` entries plus one refunded first-turn refusal for each role.
 */
function recordTurn(state, roleName, result, at) {
  // A state file written before this field exists starts with an empty history.
  if (!Array.isArray(state.turns)) {
    state.turns = [];
  }
  const ok = result.status === "ok";
  state.turns.push({
    role: roleName,
    // `status` is `ok`, `error`, or `interrupted`.
    // `interrupted` marks a charged turn whose outcome is unknown, so it carries no verdict and no reviewed head.
    status: result.status,
    // Only a reviewer turn carries a verdict; the word never comes from a
    // worker response.
    verdict: ok && roleName === "reviewer" ? parseVerdict(result.response) : null,
    head: ok ? (result.reviewed?.head ?? null) : null,
    at,
  });
}

// Builds the envelope for one dispatched turn. When the closing block does not
// parse, `raw` carries the whole response. A bounded tail can drop the head of a
// long block, and with it the text the report was meant to preserve (issue #268).
function dispatchPayload(roleName, result) {
  if (result.status !== "ok") {
    return {
      role: roleName,
      status: "error",
      error: result.error,
      ...turnResultFields(result, ["transient", "refusedModel", ...TURN_EVIDENCE_FIELDS]),
    };
  }
  const report = result.report;
  // The fields the dispatch envelope shares with the result prompt. `workTree` is the worker state
  // the runtime read after the turn (#910), not the reviewer `reviewed` field. A reviewer
  // `prChecks` is the status the runtime read for a declared PR (#320). The state file keeps it
  // beside the response in `lastResult`. The turn history entry keeps its fixed shape (ADR 0008),
  // so the status is not recorded there.
  const payload = {
    role: roleName,
    status: "ok",
    report,
    // The required labels that a null report lacks. It names the labels only, never the response
    // text, which stays in `raw` (issue #1520).
    ...(result.reportMissingLabels?.length > 0
      ? { reportMissingLabels: result.reportMissingLabels }
      : {}),
    // A parsed worker report names each label that points outside the block (issue #1907).
    ...(roleName === "worker" && result.reportOutsideBlockLabels?.length > 0
      ? { reportOutsideBlockLabels: result.reportOutsideBlockLabels }
      : {}),
    ...turnResultFields(result, ["shellDenied", "workTree", ...TURN_EVIDENCE_FIELDS]),
  };
  if (roleName === "reviewer") {
    payload.verdict = parseVerdict(result.response);
    Object.assign(payload, turnResultFields(result, ["reviewed", "prChecks"]));
  }
  if (!report) {
    payload.raw = result.response;
  }
  return payload;
}
