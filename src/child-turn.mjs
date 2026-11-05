import { defaultAgents, runAgent } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { mapInBatches } from "./lib/batches.mjs";
import { reportedEntryNames } from "./lib/entry-report.mjs";
import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import { readRequiredChecks } from "./lib/ci-gate.mjs";
import { DEFAULT_READ_TIMEOUT_MS } from "./lib/gh-api.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import { appearedInInheritedTmpdir, snapshotInheritedTmpdir } from "./lib/tmpdir-entries.mjs";
import { changedInPackageStore, snapshotPackageStore } from "./lib/package-store-entries.mjs";
import { createReviewerScratch, removeReviewerScratch } from "./lib/reviewer-scratch.mjs";
import { diffLockfiles, readLockfiles, reportedLockfilePaths } from "./lib/lockfile-change.mjs";
import { hashCopiedLocalSources } from "./lib/local-files.mjs";
import { diffMainWorkTree, readMainWorkTree } from "./lib/main-work-tree-change.mjs";
import { diffSharedGit, readSharedGit } from "./lib/shared-git.mjs";
import { reportForResult } from "./lib/report.mjs";
import { isFatalTurnError, reviewedState, snapshot, withMutationCheck } from "./lib/snapshot.mjs";
import { reportLateChangedPaths, runTestCmd } from "./lib/test-cmd.mjs";
import { carryTurnEvidence, failedTurnEvidence, pickTurnEvidence } from "./lib/turn-evidence.mjs";
import { reviewerPrompt } from "./prompts/reviewer.mjs";
import { workerPrompt } from "./prompts/worker.mjs";

// Default time bound of the whole post-turn shared Git read, which takes no turn signal.
const SHARED_GIT_READ_BOUND_MS = 10_000;

// Task of the preamble-only worker turn that follows a replaced conversation.
const PREAMBLE_ONLY_TASK =
  "No task this turn. Reply with the single word OK and change nothing. The rules above apply to every later turn.";

// Prompt of the task-only reviewer turn that follows a replaced conversation. Its reply is dropped.
const TASK_ONLY_REVIEW =
  "No review this turn. Reply with the single word OK, change nothing, and give no verdict. The init task above applies to every later turn.";

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
 * Runs one read-only probe turn in a new session and reads `state.resolvedModel` and
 * `state.initModel` from it (#394). The probe is a child turn, so it runs under the same mutation
 * check as a reviewer turn. A probe that changes the work tree throws `MutationError`, a failed
 * snapshot throws `SnapshotError`, and `signal` cancels the CLI call. Every error is thrown, never
 * returned as a result, because the caller refuses the continuation on any failure.
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
        opts: {
          cwd,
          readOnly: true,
          timeout,
          signal,
          onInitModel: (model) => {
            if (model) state.initModel = model;
          },
        },
        onEvent: () => {},
        stepsUsed: 0,
      }),
    { signal },
  );
  // A cancel can land in the post-turn snapshot, after the adapter returned (#587).
  throwIfCanceled(signal, roleName);
}

/** @typedef {import("./lib/turn-evidence.mjs").TurnEvidence} TurnEvidence */

/**
 * The pre-turn baselines and post-turn evidence caches of one child turn.
 * @typedef {object} ChildEvidenceState
 */

/**
 * Reads the pre-turn baselines that the post-turn evidence reads compare against. A linked work
 * tree shares config, hooks, and remotes with the main work tree. The work tree snapshot never
 * covers them, so a worker turn is compared on them too (issue #984). The parent installs once
 * before the first dispatch, so a worker turn that changes a lockfile leaves the next reviewer on
 * stale dependencies (issue #1180). A reviewer turn reads the inherited temporary directory and
 * the package store. The independent reads run together, and a failed read rejects before the CLI
 * starts.
 * @param {ChildEvidenceState} state
 */
async function readBeforeTurn(state) {
  if (state.isWorker) {
    const [copiedSources, shared, lockfiles, main] = await Promise.all([
      readCopiedSources(state, { signal: state.signal }),
      readShared(state),
      readLockfiles(state.cwd),
      readMainWorkTree(state.cwd),
    ]);
    state.localSourcesBefore = copiedSources;
    state.sharedBefore = shared;
    state.lockfilesBefore = lockfiles;
    state.mainBefore = main;
    return;
  }
  const [copiedSources, tmpdir, store] = await Promise.all([
    readCopiedSources(state, { signal: state.signal }),
    snapshotInheritedTmpdir(),
    snapshotPackageStore({ cwd: state.cwd }),
  ]);
  state.localSourcesBefore = copiedSources;
  state.tmpdirBefore = tmpdir;
  state.storeBefore = store;
}

/**
 * Hashes the copied sources in the main work tree, or null when the read failed. A turn window
 * compares the pre-turn and post-turn results. A source that cannot be hashed is left out, so the
 * compare reports no path it cannot prove.
 * @param {ChildEvidenceState} state
 * @param {{ signal?: AbortSignal }} [bound]
 */
async function readCopiedSources(state, { signal } = {}) {
  if (state.localFilesCopied.length === 0) {
    return {};
  }
  try {
    return await hashCopiedLocalSources(state.cwd, state.localFilesCopied, { signal });
  } catch (err) {
    if (readProp(err, "isCanceled")) throw err;
    logWarn(`local files: the copied source read failed (${err.code ?? "error"})`);
    return null;
  }
}

/**
 * Reads the shared Git state of a worker turn: hooks path, common hook files, remotes, and shared
 * config keys. The shared config keys are `core.bare`, `core.worktree`, and `extensions.*`.
 * The default bound takes the turn signal. A failed read warns and returns null, so the turn
 * reports no shared Git change rather than a guess. A read that takes the turn signal throws on a
 * cancel.
 * @param {ChildEvidenceState} state
 * @param {{ signal?: AbortSignal, deadlineMs?: number }} [bound]
 */
async function readShared(state, bound = { signal: state.signal }) {
  try {
    return await readSharedGit(state.cwd, bound);
  } catch (err) {
    if (readProp(err, "isCanceled")) throw err;
    logWarn(`worker: the shared Git state read failed: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  }
}

/**
 * Reads the work tree head and clean flag after a worker turn, so the worker field and the
 * reviewer `reviewed` field never differ in meaning. A failed read warns and returns null,
 * because the turn already ran. A cancel throws the same error.
 * @param {ChildEvidenceState} state
 */
async function readWorkTree(state) {
  try {
    const { head, clean } = reviewedState(await snapshot(state.cwd, { signal: state.signal }));
    return { head, clean };
  } catch (err) {
    if (readProp(err, "isCanceled")) throw err;
    logWarn(`worker: the work tree state read failed: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  }
}

/**
 * Paths of the main work tree that differ from the pre-turn read, or the old and new head of a
 * clean fast-forward. Both are empty or absent when the read found no change.
 * @param {ChildEvidenceState} state
 */
async function readMainWorkTreeChanged(state) {
  if (state.mainEvidence === null) {
    const after = state.mainBefore
      ? await readMainWorkTree(state.cwd, { since: state.mainBefore })
      : null;
    const fastForward = after?.fastForward ?? null;
    const paths = fastForward ? [] : diffMainWorkTree(state.mainBefore, after);
    state.mainEvidence = { mainWorkTreeChanged: paths, mainWorkTreeFastForward: fastForward };
    if (paths.length > 0) {
      logWarn(`worker: the main work tree changed: ${paths.join(", ")}`);
    } else if (fastForward) {
      logInfo(
        `worker: the main work tree fast-forwarded from ${fastForward.before} to ${fastForward.after}`,
      );
    }
  }
  return state.mainEvidence;
}

/**
 * Names of the shared Git items that differ from the pre-turn read, or [] when none or unread.
 * The read has its own time bound and takes no turn signal. A canceled turn is read too, and the
 * read never changes the cancel outcome (issue #1224).
 * @param {ChildEvidenceState} state
 */
async function readSharedGitChanged(state) {
  if (state.sharedGitItems === null) {
    const after = state.sharedBefore
      ? await readShared(state, { deadlineMs: state.sharedGitReadBoundMs })
      : null;
    state.sharedGitItems = after ? diffSharedGit(state.sharedBefore, after) : [];
    if (state.sharedGitItems.length > 0) {
      logWarn(`worker: shared Git state changed: ${state.sharedGitItems.join(", ")}`);
    }
  }
  return state.sharedGitItems;
}

/**
 * Redacted paths of the lockfiles that differ from the pre-turn read, or [] when none or unread.
 * @param {ChildEvidenceState} state
 */
async function readLockfileChanged(state) {
  if (state.lockfilePaths === null) {
    const after = state.lockfilesBefore ? await readLockfiles(state.cwd) : null;
    state.lockfilePaths = reportedLockfilePaths(diffLockfiles(state.lockfilesBefore, after));
    if (state.lockfilePaths.length > 0) {
      logWarn(`worker: lockfile changed: ${state.lockfilePaths.join(", ")}`);
    }
  }
  return state.lockfilePaths;
}

/**
 * Paths of the copied local sources that differ from the pre-turn read, redacted and capped, or
 * [] when none or unread. A source that changed inside the turn window is named by path only. The
 * read proves no actor: the user or another process can cause the change too.
 * @param {ChildEvidenceState} state
 */
async function readLocalSourceChangedInTurn(state) {
  if (state.localSourcePaths === null) {
    state.localSourcePaths = [];
    if (state.localSourcesBefore !== null && state.localFilesCopied.length > 0) {
      // No turn signal: a cancel during the turn keeps the evidence, and the read changes no outcome.
      const after = await readCopiedSources(state);
      if (after !== null) {
        const changed = new Set([...Object.keys(state.localSourcesBefore), ...Object.keys(after)]);
        state.localSourcePaths = reportedEntryNames(
          [...changed].filter((path) => state.localSourcesBefore[path] !== after[path]),
        );
        if (state.localSourcePaths.length > 0) {
          logWarn(
            `${state.isWorker ? "worker" : "reviewer"}: a copied local source changed in the turn: ${state.localSourcePaths.join(", ")}`,
          );
        }
      }
    }
  }
  return state.localSourcePaths;
}

/**
 * Names that a reviewer turn left in the inherited temporary directory, or [] when none or unread.
 * @param {ChildEvidenceState} state
 */
async function readInheritedTmpdirEntries(state) {
  const entries = await appearedInInheritedTmpdir(state.tmpdirBefore);
  if (entries.length > 0) {
    logWarn(`reviewer: entries appeared in the inherited temporary directory: ${entries.length}`);
  }
  return entries;
}

/**
 * Names that a reviewer turn changed in the pnpm package store, or [] when none or unread.
 * @param {ChildEvidenceState} state
 */
async function readPackageStoreEntries(state) {
  const entries = await changedInPackageStore(state.storeBefore, { cwd: state.cwd });
  if (entries.length > 0) {
    logWarn(`reviewer: package store entries changed: ${entries.length}`);
  }
  return entries;
}

/**
 * Reads both advisory lists together, once per turn: a later call returns the same pair.
 * @param {ChildEvidenceState} state
 */
async function readAdvisory(state) {
  if (state.advisory === null) {
    const [inheritedTmpdirEntries, packageStoreEntries] = await Promise.all([
      readInheritedTmpdirEntries(state),
      readPackageStoreEntries(state),
    ]);
    state.advisory = { inheritedTmpdirEntries, packageStoreEntries };
  }
  return state.advisory;
}

/**
 * Reads the shared Git change, the lockfile change, the main work tree change, the copied source
 * change, and both advisory lists together for a turn that failed. A rejected read throws in the
 * order shared Git, lockfile, main work tree, copied source, advisory. That is the order the reads
 * ran in before they ran together.
 * @param {ChildEvidenceState} state
 */
async function readFailedTurnEvidence(state) {
  const [sharedGitChanged, lockfileChanged, mainChange, localSourceChangedInTurn, advisory] =
    await mapInBatches(
      [
        readSharedGitChanged,
        readLockfileChanged,
        readMainWorkTreeChanged,
        readLocalSourceChangedInTurn,
        readAdvisory,
      ],
      5,
      (read) => read(state),
    );
  return {
    sharedGitChanged,
    lockfileChanged,
    ...mainChange,
    localSourceChangedInTurn,
    ...advisory,
  };
}

/**
 * Run one worker or reviewer turn with the same guards as the headless loop:
 * role prompt wrapping, read-only mutation check for the reviewer, timeout,
 * and cancel propagation. Returns `{ role, status, response }` on success and
 * `{ role, status: "error", error }` on a handled failure. Throws on fatal
 * errors: detected mutation, snapshot failure, or cancel.
 * A reviewer result also carries `reviewed` and `prChecks`. `reviewed` is the runtime-owned
 * identity of the work tree the reviewer saw. `prChecks` is the required-check status the
 * runtime read for a declared PR (#320).
 * The evidence fields listed in `lib/turn-evidence.mjs` join a result. A fatal error carries them
 * through `carryTurnEvidence` and `failedTurnEvidence`.
 * `reviewerSandbox` (`none`, `read-only`, or `workspace-write`) passes the reviewer-only `sandbox`
 * input to a reviewer turn and adds the matching prompt line; no other role receives it, and null
 * passes none (ADR 0019, ADR 0038).
 * `localFilesCopied` names the copied local paths whose sources the turn window hashes before and
 * after the child call. An absent or empty list reads no source (issue #1504).
 * A reviewer turn gets one scratch folder, named in its prompt, that the runtime removes after the
 * post-turn snapshot on every outcome. A failed removal only warns (issue #920).
 * `task` is the init task of the run. A first turn of the role, or a rerun as a first turn, shows it under
 * its own label, and a later turn does not repeat it. `role.taskSentTo` records the session id of the
 * conversation that a turn carrying the task ran in. A reviewer turn that a CLI runs in a replacement
 * conversation without the task is followed by a task-only reviewer turn in the same call (issue #890).
 * `onSessionAssigned(id)` is awaited by the Claude adapter, which pre-assigns a session id, before
 * its CLI starts, and with `null` when the CLI rejected that id. Other adapters never call it. A
 * dispatcher uses it to persist the id ahead of a crash (issue #395).
 * `onTurnTmpdir(record)` is awaited after the private temporary directory of the turn exists and
 * before its CLI starts, for an adapter of any kind (ADR 0068). A dispatcher uses
 * it to persist the record, so a later call can remove the directory of a dispatch that died
 * mid-turn (issue #1207). A failed `onTurnTmpdir` fails the turn before the CLI starts.
 * `onTurnChild(pid)` is called once the CLI has started, so the dispatcher can
 * record which process the directory belongs to. A rejection warns and never changes the turn.
 * @param {object} options
 * @returns {Promise<
 *   { role: string, status: "ok", response: string, report: object | null, shellDenied?: true,
 *     multiPartUnidentified?: true, reviewed?: object, workTree?: object, prChecks?: object } &
 *   TurnEvidence |
 *   { role: string, status: "error", error: string, transient?: string } & TurnEvidence
 * >}
 */
export async function runChild(options) {
  const {
    agents = defaultAgents,
    role,
    roleName,
    prompt,
    task = null,
    cwd,
    timeout,
    signal,
    stepsUsed = 0,
    pr = null,
    testCmd = null,
    reviewerSandbox = null,
    requiredCheckSourceUnreadable = false,
    localFilesCopied = [],
    onSessionAssigned,
    onTurnTmpdir,
    onTurnChild,
    gh,
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    sharedGitReadBoundMs = SHARED_GIT_READ_BOUND_MS,
    onEvent = () => {},
  } = options;

  const isWorker = roleName === "worker";
  const isReviewer = roleName === "reviewer";
  const readOnly = !isWorker;
  // A canceled turn leaves `conversationReplaced` set, because the replaced conversation never
  // received the worker preamble (ADR 0027, decision 5). This turn takes the mark over: the worker
  // prompt carries the preamble, and `preamblePending` keeps the mark if this turn is canceled too.
  const carriedReplaced = role.conversationReplaced === true;
  delete role.conversationReplaced;
  let preamblePending = isWorker && carriedReplaced;
  const firstTurn = role.sessionId === null || carriedReplaced;
  // The init task goes to each conversation once. `taskSentTo` names the conversation that a turn
  // carrying the task ran in, so one comparison with the current session id answers every path:
  // a first turn, a rerun, a resume after a cancel, and a replacement all read it the same way. A
  // canceled turn counts as delivered, so a dropped prompt leaves that conversation without the task.
  const taskNeeded = () =>
    task !== null && (role.sessionId === null || role.taskSentTo !== role.sessionId);
  // The worker task rides in the first-turn preamble. The reviewer prompt carries it on any turn.
  const taskFor = (first) => (taskNeeded() && (!isWorker || first) ? task : null);
  // The adapter reports the id of the conversation that the turn ran in, a replacement included.
  // That conversation received the whole prompt, so its id is the one recorded.
  const recordTaskSent = () => {
    if (role.sessionId !== null) role.taskSentTo = role.sessionId;
  };
  // The mode reaches the reviewer turn only. `readOnly` stays true there, so the mutation check
  // below still wraps the turn, and the orchestrator path never sets this input (ADR 0019, 0038).
  const sandbox = isReviewer ? reviewerSandbox : null;

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
        ...(onTurnTmpdir ? { onTurnTmpdir } : {}),
        ...(onTurnChild ? { onTurnChild } : {}),
        timeout,
        signal,
      },
      onEvent,
      stepsUsed,
    });

  // A resume that fails because the CLI has no such session leaves the stored id useless, and
  // every later turn would fail the same way. Clear the id and rerun the turn once as a first
  // turn, so a worker gets its preamble again and either role gets the init task again. The rerun belongs to the step already charged for
  // this turn: the failed resume ran no model turn, and the single rerun bounds the extra cost
  // (ADR 0016).
  // A canceled turn counts as delivered, because the CLI may have received the prompt (#826). A turn
  // that fails otherwise counts too, unless `countFailure` is false, which a caller sets when the
  // turn exists only to deliver the task.
  const invokeWithTask = async (first, buildPrompt, { countFailure = true } = {}) => {
    const turnTask = taskFor(first);
    let counted = countFailure;
    try {
      const response = await invokeRole(buildPrompt(first, turnTask));
      counted = true;
      return response;
    } catch (err) {
      if (readProp(err, "isCanceled")) counted = true;
      throw err;
    } finally {
      if (turnTask !== null && counted) recordTaskSent();
    }
  };

  const runTurn = async (buildPrompt) => {
    const resumedId = role.sessionId;
    try {
      return await invokeWithTask(firstTurn, buildPrompt);
    } catch (err) {
      if (!resumedId || !readProp(err, "sessionMissing")) {
        throw err;
      }
      logWarn(`${roleName}: session ${resumedId} is missing; rerunning the turn as a first turn`);
      role.sessionId = null;
      delete role.sessionUnconfirmed;
      return invokeWithTask(true, buildPrompt);
    }
  };

  // An adapter sets `conversationReplaced` when a resume ran the turn in a new conversation, so
  // that conversation never received the worker preamble. The turn already ran, so a rerun would
  // repeat its edits. A preamble-only turn in the new conversation gives it the preamble instead.
  // The turn that ran stays the result, so a failed preamble turn only warns (issue #396, ADR 0016).
  // The mark is cleared on every exit of `runChild` except a cancel that leaves the replaced
  // conversation without its preamble, so a step that throws after the adapter succeeded, such as
  // an event handler, leaves no stale mark for a later turn.
  const runFn = async (buildPrompt) => {
    const response = await runTurn(buildPrompt);
    preamblePending = false;
    if (role.conversationReplaced && isWorker) {
      delete role.conversationReplaced;
      preamblePending = true;
      try {
        await invokeWithTask(true, (first, turnTask) =>
          workerPrompt(PREAMBLE_ONLY_TASK, first, turnTask),
        );
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

  // A reviewer has no preamble, so a replacement conversation would get the init task only on the
  // next dispatch, and a run can finish first (issue #890). A task-only turn delivers it before the
  // verdict counts. It runs under its own mutation check, so a write in either turn is seen alone.
  // A failed turn records no delivery and throws, so the verdict of an undelivered conversation never
  // becomes an ok result. A cancel counts as delivered and keeps the replacement mark. A turn that
  // runs in a third conversation delivers the task there, and the verdict of the conversation that
  // gave it never counts, because that conversation did not get the task.
  const sendTaskToReplacement = async () => {
    if (!taskNeeded()) return;
    const verdictSession = role.sessionId;
    preamblePending = true;
    try {
      await withMutationCheck(
        cwd,
        roleName,
        () =>
          invokeWithTask(
            true,
            (first, turnTask) =>
              reviewerPrompt({
                prompt: TASK_ONLY_REVIEW,
                sandboxMode: sandbox,
                task: turnTask,
                requiredCheckSourceUnreadable,
              }),
            { countFailure: false },
          ),
        { signal },
      );
    } catch (err) {
      if (isFatalTurnError(err)) {
        throw err;
      }
      throw new Error(
        `the task turn in the new conversation failed: ${firstErrorLine(readableErrorText(err))}`,
        { cause: err },
      );
    }
    preamblePending = false;
    if (role.sessionId !== verdictSession) {
      throw new Error(
        "the task turn ran in another conversation than the review turn, so the review does not count",
      );
    }
  };

  // The worker prompt needs no runtime read, so its builder is fixed here. The
  // reviewer prompt is built inside the mutation check, where the pre-turn
  // snapshot gives the local head the status read compares against (#320).
  const buildWorkerPrompt = (first, turnTask) => workerPrompt(prompt, first, turnTask);

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
    if (!isReviewer || pr === null) {
      return null;
    }
    const status = await readRequiredChecks({
      pr,
      cwd,
      head,
      clean,
      gh,
      timeoutMs: readTimeoutMs,
      signal,
    });
    logInfo(`runtime read the required checks for PR ${pr}: ${status.summary}`);
    return status;
  };

  // Declared outside the try so a turn that fails after the command ran still
  // reports what the runtime read and the work tree change it saw (ADR 0017), and so a failed
  // worker turn still compares the shared Git state it may have changed (issue #984).
  let testRun = null;
  let keepReplacedMark = false;
  // The pre-turn baselines and post-turn evidence caches of this turn.
  const evidence = {
    cwd,
    signal,
    isWorker,
    isReviewer,
    // The copied local paths that the turn window hashes on each side.
    localFilesCopied,
    sharedGitReadBoundMs,
    sharedBefore: null,
    lockfilesBefore: null,
    mainBefore: null,
    // The pre-turn source hashes, and the post-turn paths, kept once read.
    localSourcesBefore: null,
    localSourcePaths: null,
    // The post-turn lockfile paths, kept once read so a cancel after the read reuses them.
    lockfilePaths: null,
    // The post-turn main work tree evidence, kept once read so a cancel after the read reuses it.
    mainEvidence: null,
    tmpdirBefore: null,
    storeBefore: null,
    // The post-turn advisory lists, kept once read so a cancel after the reads reuses them.
    advisory: null,
    // The post-turn shared Git items, kept once read so a cancel after the read reuses them.
    sharedGitItems: null,
  };

  try {
    let reviewed = null;
    let prChecks = null;
    // The command runs before the mutation check takes its baseline, so the
    // writes it makes are reported by the runner and are not a reviewer mutation.
    // The reviewed state below therefore describes the tree after the command
    // (ADR 0017). The command never fails the turn: a failed, timed-out, or
    // unstartable command is a result the reviewer receives.
    if (isReviewer && testCmd) {
      testRun = await runTestCmd({ ...testCmd, cwd, signal });
    }
    // The scratch folder is created before the baseline snapshot and removed after the post-turn
    // snapshot, whatever the turn returned. It is ignored, so neither snapshot lists it, and the
    // removal can neither read as a mutation nor hide one (issue #920).
    const scratchDir = isReviewer ? await createReviewerScratch(cwd, { signal }) : null;
    await readBeforeTurn(evidence);
    let response;
    try {
      response = readOnly
        ? await withMutationCheck(
            cwd,
            roleName,
            async (before) => {
              // The reviewed state comes from the runtime snapshot, never from the
              // child response, so the child cannot misreport it.
              reviewed = reviewedState(before);
              if (testRun) reportLateChangedPaths(testRun, before);
              prChecks = await readStatus(reviewed);
              return runFn((first, turnTask) =>
                reviewerPrompt({
                  prompt,
                  prChecks,
                  testRun,
                  sandboxMode: sandbox,
                  task: turnTask,
                  scratchDir,
                  requiredCheckSourceUnreadable,
                }),
              );
            },
            { signal },
          )
        : await runFn(buildWorkerPrompt);
    } finally {
      if (scratchDir !== null) await removeReviewerScratch(scratchDir);
    }
    // A worker may write, so the state after its turn is what the parent needs before a reviewer
    // runs: a PR-work tree with `clean: false` goes back to the worker (issue #910).
    // The five reads are independent, so they run together. All settle before a failure throws, so
    // a cancel in the work tree read keeps the other values for the catch path.
    const [workTree, sharedGitChanged, lockfileChanged, mainChange, localSourceChangedInTurn] =
      await mapInBatches(
        [
          isWorker ? readWorkTree : null,
          readSharedGitChanged,
          readLockfileChanged,
          readMainWorkTreeChanged,
          readLocalSourceChangedInTurn,
        ],
        5,
        (read) => (read === null ? null : read(evidence)),
      );
    if (isReviewer && role.conversationReplaced && !signal?.aborted) {
      await sendTaskToReplacement();
    }
    // Read after the last child call of the dispatch, the task-only turn included.
    const { inheritedTmpdirEntries, packageStoreEntries } = await readAdvisory(evidence);
    // A cancel can also land after the adapter returned, in the post-turn snapshot. Every result of
    // this function passes here, so no caller records a canceled turn as ok (#587).
    throwIfCanceled(signal, roleName);
    // An adapter sets `shellDenied` when the turn reported a refused tool call (ADR 0035).
    const shellDenied = role.shellDenied === true;
    // OpenCode sets `multiPartUnidentified` when the text arrived in several unidentified parts.
    const multiPartUnidentified = role.multiPartUnidentified === true;
    // An adapter returns the turn response as a string. A missing or non-string response breaks
    // that contract, so the turn fails instead of ending ok with a null report (#1496).
    if (typeof response !== "string") {
      throw new Error(
        `the ${roleName} adapter returned no string response (got ${
          response === null ? "null" : typeof response
        })`,
      );
    }
    const report = reportForResult(response, multiPartUnidentified);
    return {
      role: roleName,
      status: "ok",
      response,
      report,
      ...(shellDenied ? { shellDenied } : {}),
      ...(multiPartUnidentified ? { multiPartUnidentified } : {}),
      ...(reviewed ? { reviewed } : {}),
      ...(workTree ? { workTree } : {}),
      ...(prChecks ? { prChecks } : {}),
      ...pickTurnEvidence({
        sharedGitChanged,
        lockfileChanged,
        ...mainChange,
        localSourceChangedInTurn,
        inheritedTmpdirEntries,
        packageStoreEntries,
        testRun,
      }),
    };
  } catch (err) {
    const isCanceled = readProp(err, "isCanceled");
    if (isFatalTurnError(err)) {
      if (isCanceled) {
        logError(`${roleName} canceled by signal`);
        // The canceled turn keeps the id the CLI reported, so a replaced conversation, or one whose
        // preamble turn did not finish, keeps its mark for the next turn (ADR 0027, decision 5).
        keepReplacedMark = preamblePending || role.conversationReplaced === true;
        if (keepReplacedMark) role.conversationReplaced = true;
      }
      // A fatal error ends the turn, and the caller records it, so the result rides on it.
      // A cancel of the command itself already carries its own result.
      testRun ??= failedTurnEvidence(err).testRun ?? null;
      // A fatal error carries the entries too, because the dispatcher builds its envelope, its
      // state record, and its event from the error (issue #1024).
      if (err && typeof err === "object") {
        carryTurnEvidence(err, {
          testRun,
          ...(await readFailedTurnEvidence(evidence)),
        });
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
    // The failed turn can change the shared state before it fails. The four reads take no turn
    // signal, so a cancel never loses what they read.
    const failedEvidence = await readFailedTurnEvidence(evidence);
    // A cancel that landed during these reads ends the turn as a cancel, not as a failed turn. This
    // throw leaves the catch block, so it carries the evidence just read, as the fatal path does.
    try {
      throwIfCanceled(signal, roleName);
    } catch (canceled) {
      carryTurnEvidence(canceled, { testRun, ...failedEvidence });
      throw canceled;
    }
    // An adapter marks a failure the provider is expected to clear (issue #1012).
    const transient = readProp(err, "transient");
    return {
      role: roleName,
      status: "error",
      error: errorMessage,
      ...(typeof transient === "string" ? { transient } : {}),
      ...pickTurnEvidence({ ...failedEvidence, testRun }),
    };
  } finally {
    if (!keepReplacedMark) delete role.conversationReplaced;
    delete role.shellDenied;
    delete role.multiPartUnidentified;
  }
}
