// `agent-loop role dispatch`: initializes the run on the first call, then charges one step and runs
// one child turn under the state lock, recording the result in the state file.
import { appendFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeAgent } from "./agents/index.mjs";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT,
  readStdinText,
  readTaskFile,
  roleState,
} from "./lib/args.mjs";
import { unreadableGateReason, unreadableGateRefusal } from "./lib/ci-gate.mjs";
import { refuseHeldIds, refuseHeldSessions } from "./lib/command-line.mjs";
import { readableErrorMessage, redactedText, readProp } from "./lib/error-message.mjs";
import { sha256 } from "./lib/hash.mjs";
import { copyLocalFiles, findDifferingLocalFiles } from "./lib/local-files.mjs";
import { logInfo, logWarn } from "./lib/log.mjs";
import { processStartTime } from "./lib/process-identity.mjs";
import { parseReportBlock, parseVerdict } from "./lib/report.mjs";
import {
  TERMINAL_LIFECYCLES,
  readClaudeSessions,
  readState,
  statePaths,
  writeSessionEntry,
  writeState,
} from "./lib/runstate.mjs";
import { assertGitWorkTree } from "./lib/snapshot.mjs";
import { withStateLock } from "./lib/state-lock.mjs";
import { DEFAULT_TEST_CMD_TIMEOUT_SECONDS, testCmdInput } from "./lib/test-cmd.mjs";
import { removeAbandonedTurnTmpdir } from "./lib/turn-tmpdir.mjs";
import { failedTurnEvidence, runChild } from "./child-turn.mjs";
import {
  normalizedLocalPaths,
  rejectInitFlagChanges,
  rejectMisplacedFlags,
  storedReviewerSandbox,
  validateInitFlags,
} from "./role-args.mjs";
import { RoleError } from "./role-envelope.mjs";

/**
 * Init detection is keyed on `--task` alone: the first call carries the task;
 * later calls read the configuration from the state file, so a provided flag
 * that matches the state passes through and a changed one is rejected.
 */
function isInitCall(args) {
  return args.task !== null;
}

/**
 * Rejects a non-init call when no state file exists for the work tree.
 *
 * `needsBudget` refuses an unsafe stored `maxSteps` before the operation runs.
 * Init over an existing state, `finish`, and `extend` set it. `abort` leaves it
 * unset: refusing it would block the only route to a terminal lifecycle, because
 * a new init refuses over a non-terminal run (#312).
 */
export function requireState(state, cwd, { needsBudget = false } = {}) {
  if (!state) {
    throw new RoleError(
      `No run state for ${cwd}. Start one with: agent-loop role --task "..." --worker ... --reviewer ...`,
    );
  }
  if (needsBudget) {
    assertStateMaxSteps(state);
  }
  return state;
}

/**
 * A stored `maxSteps` is re-checked wherever the budget is read, because a state
 * file written by an earlier version, or hand-edited, reaches the step-budget
 * guard without passing through `--max-steps` validation. Outside the safe
 * integer range the step counter cannot advance by one, so the bound on `turns`
 * would hold for no accepted value. The refusal names the state file field,
 * which is what a maintainer must correct (#312).
 */
function assertStateMaxSteps(state) {
  if (!Number.isSafeInteger(state.maxSteps) || state.maxSteps < 1) {
    throw new RoleError(
      `State file field maxSteps must be a positive safe integer, got: ${JSON.stringify(state.maxSteps ?? null)}.`,
    );
  }
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
    // The state file holds a digest of the command and never the command: the
    // flag on each reviewer dispatch is the only source of what runs, and the
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
  };
}

// The recovery that the interactive path owns when it cannot declare the PR: the runtime compares
// the head, where the headless path has only the parent's marker (#1098).
const ROLE_UNREADABLE_FINISH =
  "compare the PR head with the reviewed commit through `role finish --compare-head <pr>`, or finish with the unresolvedCompare marker after you compare it yourself";

/** Refuses a PR declaration whose required-check sources the finish gate cannot read (#1092). */
export async function refuseUnreadableGate(label, { pr, cwd, gh, signal }) {
  const reason = await unreadableGateReason({ pr, cwd, gh, signal });
  if (reason) {
    throw new RoleError(unreadableGateRefusal(label, reason, ROLE_UNREADABLE_FINISH));
  }
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

export const readStdin = () =>
  readStdinText("No prompt received on stdin. Pipe a prompt or use --prompt-file.");

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
      console.error(
        redactedText(
          `Warning: Failed to append transcript to ${transcriptFile}: ${redactedText(readProp(err, "message"))}`,
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
  { agents, stdin = readStdin, signal, gh, readProcessCommands },
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
      dispatchLocked(args, { agents, stdin, signal, paths, onEvent, gh, readProcessCommands }),
    );
  } finally {
    await onEvent.flush();
  }
}

async function dispatchLocked(
  args,
  { agents, stdin, signal, paths, onEvent, gh, readProcessCommands },
) {
  const existing = await readState(paths.stateFile);
  const init = isInitCall(args);
  let state;

  if (init) {
    // New-run rule: init over a terminal or absent state file is allowed; init
    // over a non-terminal lifecycle is rejected and the parent must abort it
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
    state = initialState(args);
  } else {
    state = requireState(existing, args.cwd, { needsBudget: true });
    rejectInitFlagChanges(args, state);
  }

  const roleName = args.role;

  // The flag is the only source of the command, on every dispatch, a resume
  // included, so a reviewer dispatch of a run that set one must pass it again.
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
      // A pre-assigned session id is written before the CLI starts, so a crash during the turn
      // still leaves the id for the resume after `--resume-interrupted` (issue #395). The
      // result write below replaces it, with null when the turn kept no id.
      onSessionAssigned: async (id) => {
        recordRoleSession(state.roles[roleName], { sessionId: id, ...pickUnconfirmed(role, id) });
        await writeState(paths.stateFile, state);
      },
      // The record of the private turn directory is written before the CLI starts, so a dispatch
      // that dies mid-turn leaves it for the call that marks the run `interrupted` (issue #1207).
      // The write is a precondition of the spawn: a failure fails the turn, which the catch below
      // ends as `halted`, and the turn directory is removed.
      onTurnTmpdir: async (record) => {
        state.lastDispatch.turnTmpdir = record;
        await writeState(paths.stateFile, state);
      },
      // The child pid and start time go in after the spawn, so the recovery can tell a dead turn
      // from a dispatcher killed while its child still runs. A failed write leaves the record
      // without a child, and the recovery then keeps the directory.
      onTurnChild: async (pid) => {
        const turnTmpdir = state.lastDispatch.turnTmpdir;
        if (!turnTmpdir) return;
        turnTmpdir.child = { pid, startTime: (await processStartTime(pid)) ?? undefined };
        await writeState(paths.stateFile, state);
      },
      // The command is the flag value, which init stored a digest of or the digest
      // check above matched. Nothing the state file holds is run.
      testCmd: testCmdInput(
        args.testCmd,
        Number.isSafeInteger(state.testCmdTimeout) ? Math.max(1, state.testCmdTimeout) : undefined,
      ),
      gh,
      onEvent,
    });
  } catch (err) {
    const canceled = Boolean(readProp(err, "isCanceled"));
    const payload = dispatchPayload(roleName, {
      status: "error",
      error: readableErrorMessage(err),
      ...failedTurnEvidence(err),
    });
    // A cancel or a fatal guard error can end the turn after the CLI reported its session, so
    // keep the id for the resume that follows. A null id records a session the fallback cleared.
    recordRoleSession(state.roles[roleName], role);
    state.lifecycle = canceled ? "interrupted" : "halted";
    const at = new Date().toISOString();
    state.lastResult = { ...payload, at };
    recordTurn(state, roleName, payload, at);
    await writeState(paths.stateFile, state);
    onEvent({ type: "result", role: roleName, result: payload, stepsUsed: state.stepsUsed });
    return {
      exitCode: canceled ? 130 : 1,
      payload: withLocalFiles(payload, localFiles, localFilesDiffer),
    };
  }

  state.lifecycle = "active";
  const at = new Date().toISOString();
  state.lastResult = { ...result, at };
  recordTurn(state, roleName, result, at);
  recordRoleSession(state.roles[roleName], role);
  await writeState(paths.stateFile, state);

  onEvent({ type: "result", role: roleName, result, stepsUsed: state.stepsUsed });

  // The dispatch itself succeeded, but a child error result is still a
  // non-zero command outcome for the calling parent.
  return {
    exitCode: result.status === "ok" ? 0 : 1,
    payload: withLocalFiles(dispatchPayload(roleName, result), localFiles, localFilesDiffer),
  };
}

/**
 * Applies the lifecycle rules of a dispatch to the run state: refuses a terminal run and an
 * interrupted run without `--resume-interrupted`, records the resume decision, and marks a run
 * that ended uncertainly `interrupted` (writing the state) before it throws.
 */
async function recoverLifecycle(state, args, { paths, signal, readProcessCommands }) {
  const roleName = args.role;
  if (TERMINAL_LIFECYCLES.has(state.lifecycle)) {
    throw new RoleError(`Run is ${state.lifecycle}; no further dispatch is possible.`);
  }

  if (state.lifecycle === "interrupted") {
    if (!args.resumeInterrupted) {
      throw new RoleError(
        "Previous turn is interrupted. Use abort, or dispatch --resume-interrupted to continue.",
      );
    }
    // A hard kill of the dispatch leaves its claude child running, and the CLI accepts a resume of
    // that session, so the check comes before the step is charged (#671, ADR 0031).
    await refuseHeldSessions(
      { [roleName]: state.roles[roleName] },
      { signal, flag: "--resume-interrupted", readProcessCommands },
    );
    state.resumeDecision = { at: new Date().toISOString() };
  } else if (state.lifecycle === "dispatched") {
    // A live lock owner would have thrown in withStateLock, so the previous
    // turn ended uncertainly. The first call after the crash always marks
    // `interrupted`, exits non-zero, and spawns no child; a maintainer can
    // resume from `interrupted` on a later call.
    state.lifecycle = "interrupted";
    // The previous call charged a step and recorded no result for it, so the
    // history is missing that turn. Record it here, marked `interrupted`: no
    // child ran, so there is no verdict and no reviewed head to record. Role
    // and time come from that turn's `lastDispatch`, because this call's
    // `--role` need not be the role that ended uncertainly (#312).
    // The lock owner is dead, so no child of that turn writes into its turn directory (#1207).
    await removeAbandonedTurnTmpdir(state.lastDispatch?.turnTmpdir);
    recordTurn(
      state,
      state.lastDispatch?.role ?? roleName,
      { status: "interrupted" },
      state.lastDispatch?.at ?? new Date().toISOString(),
    );
    await writeState(paths.stateFile, state);
    throw new RoleError(
      "Previous turn ended uncertainly; state marked interrupted. Use abort, or dispatch --resume-interrupted to continue.",
    );
  }
}

/**
 * Runs the side effects of an init dispatch after every check and the prompt read passed:
 * session holder check, local file copy, archive of the old state, and the first state write.
 * Returns the local file copy result, or null when none ran.
 */
async function applyInitSideEffects(
  state,
  existing,
  args,
  { paths, signal, onEvent, readProcessCommands },
) {
  let localFiles = null;
  // A hard kill of an earlier run can leave its `claude` child alive and writing to this work
  // tree, so a live holder of a session that the earlier states recorded refuses the init (ADR 0032).
  await refuseHeldIds(await readClaudeSessions(paths.stateDir), {
    readProcessCommands,
    signal,
    label: "init",
  });
  // Every check and the prompt read passed. The copy comes first, before the
  // state file exists, so a copy that throws leaves no run to abort, and
  // before the first child turn and snapshot, so every turn sees the files.
  if (state.copyLocalFiles) {
    localFiles = await copyLocalFiles(
      args.cwd,
      {},
      { signal, extraPaths: state.copyLocalPaths ?? [] },
    );
    if (localFiles) {
      // Names only, so a later dispatch can compare each copy with its source.
      state.localFilesCopied = localFiles.copied;
      onEvent({ type: "local-files", ...localFiles });
    }
  }
  // Now archive the old terminal state file, if any, and write the new one.
  await archiveState(paths, existing);
  await writeState(paths.stateFile, state);
  if (args.parentSession) {
    await writeSessionEntry(paths.sessionEntryFile, paths.stateFile);
  }
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
 * `conversationReplaced` is set only by a canceled turn that ran in a replaced conversation, so the
 * next worker turn sends the preamble (ADR 0027, decision 5). `taskSentTo` is the session id of the
 * conversation that last carried the init task, so no path needs its own mark for it.
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
 * Names the copied local files that differ from the main work tree now. Read-only: nothing is
 * replaced. A failed comparison is a warning, not a failed dispatch, but a cancel propagates.
 */
async function differingLocalFiles(state, cwd, signal) {
  if (!state.copyLocalFiles || !state.localFilesCopied?.length) {
    return [];
  }
  try {
    return await findDifferingLocalFiles(cwd, state.localFilesCopied, { signal });
  } catch (err) {
    if (readProp(err, "isCanceled")) {
      throw err;
    }
    logWarn(`local files: the comparison with the main work tree failed (${err.code ?? "error"})`);
    return [];
  }
}

/**
 * Adds the copied and skipped path names of the init copy to the envelope, and on a later
 * dispatch the names of copies that differ from the main work tree.
 */
function withLocalFiles(payload, localFiles, localFilesDiffer) {
  return {
    ...payload,
    ...(localFiles ? { localFiles } : {}),
    ...(localFilesDiffer.length > 0 ? { localFilesDiffer } : {}),
  };
}

/**
 * Appends one turn entry to `turns`, which survives every later overwrite of
 * `lastDispatch` and `lastResult`. The entry records the turn's identity, not
 * its text: `role`, `status`, `verdict`, the reviewed `head`, and `at`. Report
 * and response text stay out of it, so the state file cannot grow with the text
 * a child returns (#312).
 *
 * Exactly one entry exists per charged step: an entry is written when a
 * dispatch records its result, when a child fails, and when the recovery call
 * records the turn a crash left uncertain. A dispatch past `maxSteps` is refused
 * before it runs, so the array holds at most `maxSteps` entries. A state file
 * written before this field exists starts with an empty history.
 *
 * `status` is `ok`, `error`, or `interrupted`. `interrupted` marks a charged
 * turn whose outcome is unknown, so it carries no verdict and no reviewed head.
 */
function recordTurn(state, roleName, result, at) {
  if (!Array.isArray(state.turns)) {
    state.turns = [];
  }
  const ok = result.status === "ok";
  state.turns.push({
    role: roleName,
    status: result.status,
    // Only a reviewer turn carries a verdict; the word never comes from a
    // worker response.
    verdict: ok && roleName === "reviewer" ? parseVerdict(result.response) : null,
    head: ok ? (result.reviewed?.head ?? null) : null,
    at,
  });
}

// The evidence fields of a turn result, in both the ok and the error envelope. `runChild` leaves out
// an empty field, so a truthy test picks the fields that the turn carries.
// - sharedGitChanged: names of the shared Git items the worker turn changed outside the work tree
//   (issue #984).
// - inheritedTmpdirEntries: names that appeared in the inherited temporary directory during a
//   reviewer turn. Advisory: the runtime cannot attribute them to the turn (issue #1024).
// - packageStoreEntries: names that changed in the pnpm package store during a reviewer turn.
//   Advisory, like the temporary directory entries (issue #1045).
// - testRun: the test command result the runtime ran before a reviewer turn (ADR 0017), for the
//   comparison with the Checks line. The state file keeps it beside the response in `lastResult`,
//   and the turn history keeps its fixed shape.
const TURN_EVIDENCE_FIELDS = [
  "sharedGitChanged",
  "inheritedTmpdirEntries",
  "packageStoreEntries",
  "testRun",
];

function turnEvidence(result) {
  return Object.fromEntries(
    TURN_EVIDENCE_FIELDS.filter((field) => result[field]).map((field) => [field, result[field]]),
  );
}

// Builds the envelope for one dispatched turn. When the closing block does not
// parse, `raw` carries the whole response: a bounded tail can drop the head of a
// long block and with it the text the report was meant to preserve (issue #268).
function dispatchPayload(roleName, result) {
  if (result.status !== "ok") {
    return {
      role: roleName,
      status: "error",
      error: result.error,
      ...(result.transient ? { transient: result.transient } : {}),
      ...turnEvidence(result),
    };
  }
  const report = parseReportBlock(result.response);
  const payload = { role: roleName, status: "ok", report };
  if (result.shellDenied) {
    payload.shellDenied = true;
  }
  // The work tree state the runtime read after a worker turn (issue #910). It is not the reviewer
  // `reviewed` field, which the finish gate reads.
  if (result.workTree) {
    payload.workTree = result.workTree;
  }
  Object.assign(payload, turnEvidence(result));
  if (roleName === "reviewer") {
    payload.verdict = parseVerdict(result.response);
    if (result.reviewed) {
      payload.reviewed = result.reviewed;
    }
    // The required-check status the runtime read for a declared PR, so the
    // parent can compare it with the reviewer Checks line (#320). The state file
    // keeps it beside the response in `lastResult`. The turn history entry keeps
    // its fixed shape (ADR 0008), so the status is not recorded there.
    if (result.prChecks) {
      payload.prChecks = result.prChecks;
    }
  }
  if (!report) {
    payload.raw = result.response;
  }
  return payload;
}
