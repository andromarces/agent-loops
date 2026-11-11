import { mapInBatches } from "../batches.mjs";
import { reportedEntryNames } from "./entry-report.mjs";
import { errorLine, readProp } from "../error-message.mjs";
import { logInfo, logWarn } from "../log.mjs";
import {
  appearedInInheritedTmpdir,
  literalTmpdirRoots,
  snapshotInheritedTmpdir,
} from "./tmpdir-entries.mjs";
import { changedInPackageStore, snapshotPackageStore } from "./package-store-entries.mjs";
import { diffLockfiles, readLockfiles, reportedLockfilePaths } from "./lockfile-change.mjs";
import { hashCopiedLocalSources } from "../local-file-changes.mjs";
import {
  diffMainWorkTree,
  diffMainWorkTreeInTurn,
  readMainWorkTree,
} from "./main-work-tree-change.mjs";
import { startMainWorkTreeWatch } from "./main-work-tree-watch.mjs";
import { diffSharedGit, differing, readSharedGit } from "./shared-git.mjs";
import { reviewedState, snapshot } from "../snapshot.mjs";

/**
 * The pre-turn baselines and post-turn evidence caches of one child turn.
 * @typedef {object} ChildEvidenceState
 * @property {string} cwd
 * @property {AbortSignal | undefined} signal
 * @property {boolean} isWorker
 * @property {string[]} localFilesCopied
 * @property {number} sharedGitReadBoundMs
 * @property {object | null} sharedBefore
 * @property {object | null} lockfilesBefore
 * @property {object | null} mainBefore
 * @property {object | null} mainWatch
 * @property {number | undefined} mainWatchDeadlineMs
 * @property {number | undefined} mainReadDeadlineMs
 * @property {object | null} localSourcesBefore
 * @property {string[] | null} localSourcePaths
 * @property {string[] | null} lockfilePaths
 * @property {object | null} mainEvidence
 * @property {object | null} tmpdirBefore
 * @property {string[]} tmpdirLiteralRoots
 * @property {object | null} storeBefore
 * @property {object | null} advisory
 * @property {string[] | null} sharedGitItems
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
    const mainRead = readMainWorkTree(state.cwd, { deadlineMs: state.mainReadDeadlineMs });
    const [copiedSources, shared, lockfiles, main, tmpdir] = await Promise.all([
      readCopiedSources(state, { signal: state.signal }),
      readShared(state),
      readLockfiles(state.cwd),
      mainRead,
      // A worker turn reports a literal system temporary directory that differs from the inherited
      // one, but not the inherited directory itself, which it may legitimately write in (#1713).
      snapshotInheritedTmpdir({
        literalRoots: state.tmpdirLiteralRoots,
        includeInherited: false,
      }),
    ]);
    state.localSourcesBefore = copiedSources;
    state.sharedBefore = shared;
    state.lockfilesBefore = lockfiles;
    state.mainBefore = main;
    state.tmpdirBefore = tmpdir;
    // The watch starts before the child call, so an edit that the turn restores still leaves a path.
    state.mainWatch = main
      ? await startMainWorkTreeWatch(main.root, {
          drainDeadlineMs: state.mainWatchDeadlineMs,
          signal: state.signal,
        })
      : null;
    return;
  }
  const [copiedSources, tmpdir, store] = await Promise.all([
    readCopiedSources(state, { signal: state.signal }),
    snapshotInheritedTmpdir({ literalRoots: state.tmpdirLiteralRoots }),
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
    logWarn(`worker: the shared Git state read failed: ${errorLine(err)}`);
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
    logWarn(`worker: the work tree state read failed: ${errorLine(err)}`);
    return null;
  }
}

/**
 * Paths of the main work tree that differ from the pre-turn read. Also the old and new head of a
 * clean fast-forward, and the paths that the watch saw change and restore inside the window. Each
 * list is empty or absent when its read found no change.
 * @param {ChildEvidenceState} state
 */
async function readMainWorkTreeChanged(state) {
  if (state.mainEvidence === null) {
    const after = state.mainBefore
      ? await readMainWorkTree(state.cwd, { since: state.mainBefore })
      : null;
    const fastForward = after?.fastForward ?? null;
    const paths = fastForward ? [] : diffMainWorkTree(state.mainBefore, after);
    const watched = after && state.mainWatch ? await state.mainWatch.take() : null;
    const inTurn =
      watched && !watched.failed
        ? diffMainWorkTreeInTurn(state.mainBefore, after, watched.candidates, {
            exclude: after?.commitPaths ?? [],
          })
        : [];
    state.mainEvidence = {
      mainWorkTreeChanged: paths,
      mainWorkTreeChangedInTurn: inTurn,
      mainWorkTreeFastForward: fastForward,
    };
    if (paths.length > 0) {
      logWarn(`worker: the main work tree changed: ${paths.join(", ")}`);
    } else if (fastForward) {
      logInfo(
        `worker: the main work tree fast-forwarded from ${fastForward.before} to ${fastForward.after}`,
      );
    }
    if (inTurn.length > 0) {
      logWarn(`worker: the main work tree changed inside the turn: ${inTurn.join(", ")}`);
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
        state.localSourcePaths = reportedEntryNames(differing(state.localSourcesBefore, after));
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
 * Names that a turn left in the inherited temporary directory, or in a literal system temporary
 * directory that differs from it, or [] when none or unread. A worker turn reports only the literal
 * roots, because it may legitimately write in the inherited directory.
 * @param {ChildEvidenceState} state
 */
async function readInheritedTmpdirEntries(state) {
  const entries = await appearedInInheritedTmpdir(state.tmpdirBefore, {
    includeInherited: !state.isWorker,
  });
  if (entries.length > 0) {
    logWarn(
      state.isWorker
        ? `worker: entries appeared in a literal system temporary directory: ${entries.length}`
        : `reviewer: entries appeared in the inherited temporary directory or a literal one: ${entries.length}`,
    );
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
 * Builds the pre-turn baselines and post-turn evidence reads of one child turn. The post-turn reads
 * keep their result for the turn, so a later call returns the same value. `beforeTurn` runs once
 * before the CLI call and `workTree` reads the work tree once after it. `beforeTurn` also starts the
 * main work tree watch, which `mainWatch` exposes and `stop` closes; call `stop` on every outcome.
 * @param {{ cwd: string, signal?: AbortSignal, isWorker: boolean, localFilesCopied: string[],
 *   sharedGitReadBoundMs: number, mainWatchDeadlineMs?: number | null,
 *   mainReadDeadlineMs?: number | null, tmpdirLiteralRoots?: string[] }} options
 */
export function createTurnEvidence({
  cwd,
  signal,
  isWorker,
  localFilesCopied,
  sharedGitReadBoundMs,
  mainWatchDeadlineMs,
  mainReadDeadlineMs,
  // The literal system temporary directories to read beside the inherited one. A test names them
  // so the churn of the host's `/tmp` stays out of the report.
  tmpdirLiteralRoots = literalTmpdirRoots(),
}) {
  const state = {
    cwd,
    signal,
    isWorker,
    // The copied local paths that the turn window hashes on each side.
    localFilesCopied,
    sharedGitReadBoundMs,
    sharedBefore: null,
    lockfilesBefore: null,
    mainBefore: null,
    // The turn-window watch of the main work tree, stopped on every outcome.
    mainWatch: null,
    mainWatchDeadlineMs: mainWatchDeadlineMs ?? undefined,
    mainReadDeadlineMs: mainReadDeadlineMs ?? undefined,
    // The pre-turn source hashes, and the post-turn paths, kept once read.
    localSourcesBefore: null,
    localSourcePaths: null,
    // The post-turn lockfile paths, kept once read so a cancel after the read reuses them.
    lockfilePaths: null,
    // The post-turn main work tree evidence, kept once read so a cancel after the read reuses it.
    mainEvidence: null,
    tmpdirBefore: null,
    tmpdirLiteralRoots,
    storeBefore: null,
    // The post-turn advisory lists, kept once read so a cancel after the reads reuses them.
    advisory: null,
    // The post-turn shared Git items, kept once read so a cancel after the read reuses them.
    sharedGitItems: null,
  };
  return {
    get mainWatch() {
      return state.mainWatch;
    },
    beforeTurn: () => readBeforeTurn(state),
    workTree: () => readWorkTree(state),
    sharedGitChanged: () => readSharedGitChanged(state),
    lockfileChanged: () => readLockfileChanged(state),
    mainWorkTreeChanged: () => readMainWorkTreeChanged(state),
    localSourceChangedInTurn: () => readLocalSourceChangedInTurn(state),
    advisory: () => readAdvisory(state),
    failed: () => readFailedTurnEvidence(state),
    /** Closes the main work tree watch and settles every read it holds. */
    stop: async () => {
      await state.mainWatch?.stop();
    },
  };
}
