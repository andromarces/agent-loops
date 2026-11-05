import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { gitRead, stripLf } from "./git-read.mjs";
import { mainWorkTreePath } from "./local-files.mjs";
import { logWarn } from "./log.mjs";
import { snapshot } from "./snapshot.mjs";
import { withTimeBound } from "./time-bound.mjs";

// Whole-read bound, including main work tree resolution and content hashing.
const READ_BOUND_MS = 10_000;

/**
 * Reads the tracked and untracked, unignored state of the main work tree that a linked `cwd` belongs
 * to. The result holds the HEAD commit, the checked-out branch, and a map of path to status and
 * content hash. With `since`, a changed HEAD or branch adds the paths of `git diff --name-only`
 * between the two commits. A clean fast-forward to the remote default branch adds `fastForward`.
 * The result is null when `cwd` is the main work tree, the layout has none, or the read fails or
 * passes its bound. A failed read warns, and an absent result then proves nothing.
 * @param {string} cwd
 * @param {{ deadlineMs?: number, since?: object | null }} [options]
 * @returns {Promise<object | null>}
 */
export async function readMainWorkTree(cwd, { deadlineMs = READ_BOUND_MS, since = null } = {}) {
  try {
    return await withTimeBound(
      deadlineMs,
      `the main work tree read took over ${deadlineMs} ms`,
      async ({ signal, stopped }) => {
        const main = await Promise.race([mainWorkTreePath(cwd, { signal }), stopped]);
        if (main === null) return null;
        // The read takes no optional Git lock, so it never writes the main work tree index.
        const bound = { signal, timeoutMs: deadlineMs };
        const [snap, branch] = await Promise.all([
          Promise.race([snapshot(main, { ...bound, env: { GIT_OPTIONAL_LOCKS: "0" } }), stopped]),
          Promise.race([readBranch(main, bound), stopped]),
        ]);
        const state = {
          entries: new Map(snap.workTree.map((entry) => [entry.path, stateOf(entry)])),
          head: snap.head,
          branch,
        };
        if (since && (since.head !== state.head || since.branch !== state.branch)) {
          state.commitPaths = await Promise.race([
            readCommitPaths(main, since.head, state.head, bound),
            stopped,
          ]);
          // The deadline race keeps the commit paths above.
          state.fastForward = await readFastForwardWithinDeadline(
            main,
            since,
            state,
            bound,
            stopped,
          );
        }
        return state;
      },
    );
  } catch (err) {
    logWarn(
      `worker: the main work tree state read failed: ${firstErrorLine(readableErrorText(err))}`,
    );
    return null;
  }
}

const stateOf = (entry) => `${entry.status}\0${entry.hash ?? ""}`;

/** Reads the checked-out branch of `main`, or null for a detached HEAD. */
async function readBranch(main, bound) {
  const result = await gitRead(main, ["symbolic-ref", "--short", "-q", "HEAD"], {
    ...bound,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stripFinalNewline: false,
  });
  return result.exitCode === 0 ? stripLf(result.stdout) : null;
}

/**
 * Names the old and new head when the move is a clean fast-forward to the remote default branch.
 * Returns null for a dirty, untracked, or unignored state on either read, a detached head, or a
 * branch switch. A reset, a non-fast-forward move, a local commit on top, or an unreadable or
 * moving ref also returns null. A timeout or read error returns null too, so the commit paths stay.
 */
async function readFastForward(main, before, after, bound) {
  try {
    return await classifyFastForward(main, before, after, bound);
  } catch {
    return null;
  }
}

/**
 * Races the fast-forward check against the read deadline. A deadline that wins returns null at
 * once, and the aborted check settles on its own with its rejection handled.
 */
function readFastForwardWithinDeadline(main, before, after, bound, stopped) {
  const classification = readFastForward(main, before, after, bound);
  // A late rejection after the deadline stays handled and never raises.
  classification.catch(() => {});
  return Promise.race([
    classification,
    stopped.then(
      () => null,
      () => null,
    ),
  ]);
}

async function classifyFastForward(main, before, after, bound) {
  if (before.entries.size > 0 || after.entries.size > 0) return null;
  if (before.branch === null || before.branch !== after.branch) return null;
  if (before.head === "unborn" || after.head === "unborn") return null;
  if (before.head === after.head) return null;
  const ancestor = await gitRead(main, ["merge-base", "--is-ancestor", before.head, after.head], {
    ...bound,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  if (ancestor.exitCode !== 0) return null;
  const first = await readDefaultBranchRef(main, bound);
  if (first === null || first.name !== after.branch || first.sha !== after.head) return null;
  // A second read keeps a ref that moves during the turn from passing as the turn's result.
  const second = await readDefaultBranchRef(main, bound);
  if (second === null || second.name !== first.name || second.sha !== first.sha) return null;
  return { before: before.head, after: after.head };
}

/** Reads the commit that `refs/remotes/origin/HEAD` names, or null when the ref is absent. */
async function readDefaultBranchRef(main, bound) {
  const symbolic = await gitRead(main, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
    ...bound,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stripFinalNewline: false,
  });
  if (symbolic.exitCode !== 0) return null;
  const ref = stripLf(symbolic.stdout);
  const prefix = "refs/remotes/origin/";
  if (!ref.startsWith(prefix) || ref.length === prefix.length) return null;
  const sha = await gitRead(main, ["rev-parse", "--verify", "-q", ref], {
    ...bound,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  if (sha.exitCode !== 0) return null;
  return { name: ref.slice(prefix.length), sha: sha.stdout.trim() };
}

/** Reads the paths that differ between two commits, or [] when either is unborn. */
async function readCommitPaths(main, beforeHead, afterHead, bound) {
  if (beforeHead === afterHead || beforeHead === "unborn" || afterHead === "unborn") return [];
  const result = await gitRead(
    main,
    ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", beforeHead, afterHead],
    {
      ...bound,
      allowExit: [0],
      env: { GIT_OPTIONAL_LOCKS: "0" },
      stripFinalNewline: false,
    },
  );
  return result.stdout.split("\0").filter(Boolean);
}

/**
 * Names the paths that differ between two `readMainWorkTree` results, by path relative to the main
 * work tree. It includes dirty entries and paths from a changed HEAD commit. Returns [] when either
 * read is missing, at most 20 names, and never content.
 * @param {object | null} before
 * @param {object | null} after
 * @returns {string[]}
 */
export function diffMainWorkTree(before, after) {
  if (!before || !after) return [];
  const changed = new Set(after.commitPaths ?? []);
  for (const [path, state] of before.entries) {
    if (after.entries.get(path) !== state) changed.add(path);
  }
  for (const path of after.entries.keys()) {
    if (!before.entries.has(path)) changed.add(path);
  }
  return reportedEntryNames(changed);
}

const carrier = entryCarrier("mainWorkTreeChanged");

/**
 * Carries the paths on a fatal error as `err.mainWorkTreeChanged`. A frozen error or a throwing
 * setter keeps the original error, and the paths stay readable through `failedMainWorkTreeChanged`.
 */
export const carryMainWorkTreeChanged = carrier.carry;

/** Returns the paths a fatal error carries, or `undefined` when it carries none. */
export const failedMainWorkTreeChanged = carrier.failed;

const fastForwardCarrier = entryCarrier("mainWorkTreeFastForward");

/**
 * Carries the clean fast-forward heads on a fatal error as `err.mainWorkTreeFastForward`. A frozen
 * error or a throwing setter keeps the original error, and the heads stay readable through
 * `failedMainWorkTreeFastForward`.
 */
export const carryMainWorkTreeFastForward = fastForwardCarrier.carry;

/** Returns the fast-forward heads a fatal error carries, or `undefined` when it carries none. */
export const failedMainWorkTreeFastForward = fastForwardCarrier.failed;
