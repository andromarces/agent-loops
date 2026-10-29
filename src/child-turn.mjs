import { defaultAgents, runAgent } from "./agents/index.mjs";
import { throwIfCanceled } from "./agents/shared.mjs";
import { firstErrorLine, readableErrorText, readProp } from "./lib/error-message.mjs";
import { DEFAULT_READ_TIMEOUT_MS, readRequiredChecks } from "./lib/ci-gate.mjs";
import { logError, logInfo, logWarn } from "./lib/log.mjs";
import {
  appearedInInheritedTmpdir,
  carryInheritedTmpdirEntries,
  failedInheritedTmpdirEntries,
  snapshotInheritedTmpdir,
} from "./lib/tmpdir-entries.mjs";
import {
  carryPackageStoreEntries,
  changedInPackageStore,
  failedPackageStoreEntries,
  snapshotPackageStore,
} from "./lib/package-store-entries.mjs";
import { createReviewerScratch, removeReviewerScratch } from "./lib/reviewer-scratch.mjs";
import {
  carryLockfileChanged,
  diffLockfiles,
  failedLockfileChanged,
  readLockfiles,
} from "./lib/lockfile-change.mjs";
import { diffSharedGit, readSharedGit } from "./lib/shared-git.mjs";
import { reviewedState, snapshot, withMutationCheck } from "./lib/snapshot.mjs";
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

// The evidence fields of a turn result, in both the ok and the error envelope, the result prompt,
// and the fatal-path events. The consumers of this list pick up a new field with no change. The field
// still needs these edits:
// - The producer in `runChild` sets its value, in the ok result and in the error result.
// - The `TurnEvidence` typedef below names it.
// - A field that must survive a fatal error also joins `carryTurnEvidence` and `failedTurnEvidence`.
//   The fatal-path events in `runtime.mjs` also name it. `sharedGitChanged` does neither.
// - sharedGitChanged: names of the shared Git items the worker turn changed outside the work tree
//   (issue #984).
// - lockfileChanged: paths of the lockfiles the worker turn changed, so the parent reinstalls
//   before the next reviewer turn (issue #1180).
// - inheritedTmpdirEntries: names that appeared in the inherited temporary directory during a
//   reviewer turn. Advisory: the runtime cannot attribute them to the turn (issue #1024).
// - packageStoreEntries: names that changed in the pnpm package store during a reviewer turn.
//   Advisory, like the temporary directory entries (issue #1045).
// - testRun: the test command result the runtime ran before a reviewer turn (ADR 0017), for the
//   comparison with the Checks line. The state file keeps it beside the response in `lastResult`,
//   and the turn history keeps its fixed shape.
const TURN_EVIDENCE_FIELDS = [
  "sharedGitChanged",
  "lockfileChanged",
  "inheritedTmpdirEntries",
  "packageStoreEntries",
  "testRun",
];

/** Picks the evidence fields of `source` that carry a value. A falsy field and an empty list are dropped. */
export function pickTurnEvidence(source) {
  return Object.fromEntries(
    TURN_EVIDENCE_FIELDS.filter((field) =>
      Array.isArray(source[field]) ? source[field].length > 0 : source[field],
    ).map((field) => [field, source[field]]),
  );
}

/**
 * Carries the evidence of a failed turn on a fatal error: the `--test-cmd` result, the lockfile
 * paths, and the two advisory lists. An absent or empty field is skipped, and so is an error that
 * cannot take it.
 */
function carryTurnEvidence(
  err,
  { testRun, lockfileChanged, inheritedTmpdirEntries, packageStoreEntries },
) {
  if (!err || typeof err !== "object") return;
  if (testRun) carryTestRun(err, testRun);
  if (lockfileChanged?.length > 0) carryLockfileChanged(err, lockfileChanged);
  if (inheritedTmpdirEntries?.length > 0) carryInheritedTmpdirEntries(err, inheritedTmpdirEntries);
  if (packageStoreEntries?.length > 0) carryPackageStoreEntries(err, packageStoreEntries);
}

/** Reads back what `carryTurnEvidence` carried. A field the error does not carry is `undefined`. */
export function failedTurnEvidence(err) {
  return {
    testRun: failedTestRun(err),
    lockfileChanged: failedLockfileChanged(err),
    inheritedTmpdirEntries: failedInheritedTmpdirEntries(err),
    packageStoreEntries: failedPackageStoreEntries(err),
  };
}

/** @typedef {{ sharedGitChanged?: string[], lockfileChanged?: string[], inheritedTmpdirEntries?: string[], packageStoreEntries?: string[], testRun?: object }} TurnEvidence */

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
 * A reviewer turn gets one scratch folder, named in its prompt, that the runtime removes after the
 * post-turn snapshot on every outcome. A failed removal only warns (issue #920).
 * A reviewer result carries `inheritedTmpdirEntries`, the names that appeared directly in the inherited
 * temporary directory during the turn, only when some did. A fatal error carries the list as
 * `err.inheritedTmpdirEntries`, read through `failedInheritedTmpdirEntries`. The list is advisory:
 * the directory is shared with other processes, so the runtime cannot attribute an entry to the turn
 * and deletes none (issue #1024).
 * A reviewer result carries `packageStoreEntries` the same way, the names that appeared, changed, or
 * vanished in the pnpm package store during the turn, and a fatal error carries it as
 * `err.packageStoreEntries`, read through `failedPackageStoreEntries`. The list is advisory for the
 * same reason, and the read is bounded in time and size and never reads file content (issue #1045).
 * Each list is scanned once per turn, both lists together, and a cancel after that scan reuses them.
 * `task` is the init task of the run. A first turn of the role, or a rerun as a first turn, shows it under
 * its own label, and a later turn does not repeat it. `role.taskSentTo` records the session id of the
 * conversation that a turn carrying the task ran in. A reviewer turn that a CLI runs in a replacement
 * conversation without the task is followed by a task-only reviewer turn in the same call (issue #890).
 * `onSessionAssigned(id)` is awaited by the Claude adapter, which pre-assigns a session id, before
 * its CLI starts, and with `null` when the CLI rejected that id. Other adapters never call it. A
 * dispatcher uses it to persist the id ahead of a crash (issue #395).
 * `onTurnTmpdir(record)` is awaited by the Codex adapter after it creates the private temporary
 * directory of the turn and before its CLI starts. Other adapters never call it. A dispatcher uses
 * it to persist the record, so a later call can remove the directory of a dispatch that died
 * mid-turn (issue #1207). A failed `onTurnTmpdir` fails the turn before the CLI starts.
 * `onTurnChild(pid)` is called by the Codex adapter once the CLI has started, so the dispatcher can
 * record which process the directory belongs to. A rejection warns and never changes the turn.
 * @param {object} options
 * @returns {Promise<{ role: string, status: "ok", response: string, shellDenied?: true, reviewed?: object, workTree?: object, prChecks?: object } & TurnEvidence | { role: string, status: "error", error: string, transient?: string } & TurnEvidence>}
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
    onSessionAssigned,
    onTurnTmpdir,
    onTurnChild,
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
            (first, turnTask) => reviewerPrompt(TASK_ONLY_REVIEW, null, null, sandbox, turnTask),
            { countFailure: false },
          ),
        { signal },
      );
    } catch (err) {
      const name = readProp(err, "name");
      if (name === "MutationError" || name === "SnapshotError" || readProp(err, "isCanceled")) {
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
    if (roleName !== "reviewer" || pr === null) {
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

  /**
   * Reads the work tree state after a worker turn: the `head` and `clean` of the shared
   * `reviewedState`, so the worker field and the reviewer `reviewed` field never differ in
   * meaning. A failed read warns and returns null, because the turn already ran. A cancel throws.
   */
  const readWorkTree = async () => {
    try {
      const { head, clean } = reviewedState(await snapshot(cwd, { signal }));
      return { head, clean };
    } catch (err) {
      if (readProp(err, "isCanceled")) throw err;
      logWarn(`worker: the work tree state read failed: ${firstErrorLine(readableErrorText(err))}`);
      return null;
    }
  };

  /**
   * Reads the shared Git state (hooks path, common hook files, remotes) of a worker turn. A failed
   * read warns and returns null, so the turn reports no shared Git change rather than a guess. A
   * cancel throws.
   */
  const readShared = async () => {
    try {
      return await readSharedGit(cwd, { signal });
    } catch (err) {
      if (readProp(err, "isCanceled")) throw err;
      logWarn(
        `worker: the shared Git state read failed: ${firstErrorLine(readableErrorText(err))}`,
      );
      return null;
    }
  };

  // Declared outside the try so a turn that fails after the command ran still
  // reports what the runtime read and the work tree change it saw (ADR 0017), and so a failed
  // worker turn still compares the shared Git state it may have changed (issue #984).
  let testRun = null;
  let keepReplacedMark = false;
  let sharedBefore = null;
  let lockfilesBefore = null;
  // The post-turn lockfile paths, kept once read so a cancel after the read reuses them.
  let lockfilePaths = null;
  let tmpdirBefore = null;
  let storeBefore = null;
  // The post-turn advisory lists, kept once read so a cancel after the reads reuses them.
  let advisory = null;

  /** Names of the shared Git items that differ from the pre-turn read, or [] when none or unread. */
  const readSharedGitChanged = async () => {
    const after = sharedBefore ? await readShared() : null;
    const changed = after ? diffSharedGit(sharedBefore, after) : [];
    if (changed.length > 0) {
      logWarn(`worker: shared Git state changed: ${changed.join(", ")}`);
    }
    return changed;
  };
  /** Paths of the lockfiles that differ from the pre-turn read, or [] when none or unread. */
  const readLockfileChanged = async () => {
    if (lockfilePaths === null) {
      const after = lockfilesBefore ? await readLockfiles(cwd) : null;
      lockfilePaths = diffLockfiles(lockfilesBefore, after);
      if (lockfilePaths.length > 0) {
        logWarn(`worker: lockfile changed: ${lockfilePaths.join(", ")}`);
      }
    }
    return lockfilePaths;
  };
  /** Names that a reviewer turn left in the inherited temporary directory, or [] when none or unread. */
  const readInheritedTmpdirEntries = async () => {
    const entries = await appearedInInheritedTmpdir(tmpdirBefore);
    if (entries.length > 0) {
      logWarn(`reviewer: entries appeared in the inherited temporary directory: ${entries.length}`);
    }
    return entries;
  };
  /** Names that a reviewer turn changed in the pnpm package store, or [] when none or unread. */
  const readPackageStoreEntries = async () => {
    const entries = await changedInPackageStore(storeBefore, { cwd });
    if (entries.length > 0) {
      logWarn(`reviewer: package store entries changed: ${entries.length}`);
    }
    return entries;
  };
  /** Reads both advisory lists together, once per turn: a later call returns the same pair. */
  const readAdvisory = async () => {
    if (advisory === null) {
      const [inheritedTmpdirEntries, packageStoreEntries] = await Promise.all([
        readInheritedTmpdirEntries(),
        readPackageStoreEntries(),
      ]);
      advisory = { inheritedTmpdirEntries, packageStoreEntries };
    }
    return advisory;
  };
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
    // The scratch folder is created before the baseline snapshot and removed after the post-turn
    // snapshot, whatever the turn returned. It is ignored, so neither snapshot lists it, and the
    // removal can neither read as a mutation nor hide one (issue #920).
    const scratchDir =
      roleName === "reviewer" ? await createReviewerScratch(cwd, { signal }) : null;
    // A linked work tree shares config, hooks, and remotes with the main work tree, which the work
    // tree snapshot never covers, so a worker turn is compared on them too (issue #984).
    sharedBefore = roleName === "worker" ? await readShared() : null;
    // The parent installs once before the first dispatch, so a worker turn that changes a lockfile
    // leaves the next reviewer on stale dependencies (issue #1180).
    lockfilesBefore = roleName === "worker" ? await readLockfiles(cwd) : null;
    if (roleName === "reviewer") {
      [tmpdirBefore, storeBefore] = await Promise.all([
        snapshotInheritedTmpdir(),
        snapshotPackageStore({ cwd }),
      ]);
    }
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
                reviewerPrompt(prompt, prChecks, testRun, sandbox, turnTask, scratchDir),
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
    const workTree = roleName === "worker" ? await readWorkTree() : null;
    const sharedGitChanged = await readSharedGitChanged();
    const lockfileChanged = await readLockfileChanged();
    if (roleName === "reviewer" && role.conversationReplaced && !signal?.aborted) {
      await sendTaskToReplacement();
    }
    // Read after the last child call of the dispatch, the task-only turn included.
    const { inheritedTmpdirEntries, packageStoreEntries } = await readAdvisory();
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
      ...(workTree ? { workTree } : {}),
      ...(prChecks ? { prChecks } : {}),
      ...pickTurnEvidence({
        sharedGitChanged,
        lockfileChanged,
        inheritedTmpdirEntries,
        packageStoreEntries,
        testRun,
      }),
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
      // A fatal error carries the entries too, because the dispatcher builds its envelope, its
      // state record, and its event from the error (issue #1024).
      if (err && typeof err === "object") {
        carryTurnEvidence(err, {
          testRun,
          lockfileChanged: await readLockfileChanged(),
          ...(await readAdvisory()),
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
    // The failed turn may have changed the shared state before it failed. The lockfile read comes
    // first and takes no turn signal, so a cancel that the shared Git read throws still carries it.
    const lockfileChanged = await readLockfileChanged();
    let sharedGitChanged;
    try {
      sharedGitChanged = await readSharedGitChanged();
    } catch (canceled) {
      if (canceled && typeof canceled === "object") {
        carryTurnEvidence(canceled, { testRun, lockfileChanged, ...(await readAdvisory()) });
      }
      throw canceled;
    }
    const { inheritedTmpdirEntries, packageStoreEntries } = await readAdvisory();
    // A cancel that landed during these reads ends the turn as a cancel, not as a failed turn. This
    // throw leaves the catch block, so it carries the evidence just read, as the fatal path does.
    try {
      throwIfCanceled(signal, roleName);
    } catch (canceled) {
      carryTurnEvidence(canceled, {
        testRun,
        lockfileChanged,
        inheritedTmpdirEntries,
        packageStoreEntries,
      });
      throw canceled;
    }
    // An adapter marks a failure the provider is expected to clear (issue #1012).
    const transient = readProp(err, "transient");
    return {
      role: roleName,
      status: "error",
      error: errorMessage,
      ...(typeof transient === "string" ? { transient } : {}),
      ...pickTurnEvidence({
        sharedGitChanged,
        lockfileChanged,
        inheritedTmpdirEntries,
        packageStoreEntries,
        testRun,
      }),
    };
  } finally {
    if (!keepReplacedMark) delete role.conversationReplaced;
    delete role.shellDenied;
  }
}
