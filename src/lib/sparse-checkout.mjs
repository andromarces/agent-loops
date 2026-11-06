// Reads the sparse checkout that a linked `cwd` can inherit from the main work tree. The init
// envelope then reports the tracked files that the run work tree lacks (issue #1538).
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { gitRead } from "./git-read.mjs";
import { mainWorkTreePath } from "./local-files.mjs";
import { logWarn } from "./log.mjs";
import { withTimeBound } from "./time-bound.mjs";

// Whole-read bound, including the main work tree resolution.
const READ_BOUND_MS = 10_000;

/**
 * Reads the sparse-checkout setting and the skip-worktree entries of a linked `cwd`. Returns
 * `{ enabled, skipWorktree }` when the setting is on or a tracked path is excluded. Returns null
 * when `cwd` is the main work tree, the layout has none, or the read fails or passes `deadlineMs`.
 * A failed read warns, and a null result then proves nothing.
 * @param {string} cwd
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<{ enabled: boolean, skipWorktree: string[] } | null>}
 */
export async function readSparseCheckout(cwd, { deadlineMs = READ_BOUND_MS } = {}) {
  try {
    return await withTimeBound(
      deadlineMs,
      `the sparse-checkout read took over ${deadlineMs} ms`,
      async ({ signal, stopped }) => {
        // A linked work tree alone can inherit the main work tree's exclusion.
        const main = await Promise.race([mainWorkTreePath(cwd, { signal }), stopped]);
        if (main === null) return null;
        // The reads take no optional Git lock, so they never write the work tree index.
        const bound = { signal, timeoutMs: deadlineMs };
        const [enabled, skipWorktree] = await Promise.all([
          Promise.race([readEnabled(cwd, bound), stopped]),
          Promise.race([readSkipWorktree(cwd, bound), stopped]),
        ]);
        if (!enabled && skipWorktree.length === 0) return null;
        return { enabled, skipWorktree };
      },
    );
  } catch (err) {
    logWarn(`init: the sparse-checkout read failed: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  }
}

/** Reads `core.sparseCheckout` as the work tree's effective boolean setting. */
async function readEnabled(cwd, bound) {
  const result = await gitRead(cwd, ["config", "--bool", "--get", "core.sparseCheckout"], {
    ...bound,
    allowExit: [0, 1],
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Reads the tracked paths that carry the skip-worktree bit. */
async function readSkipWorktree(cwd, bound) {
  const result = await gitRead(cwd, ["ls-files", "-t", "-z"], {
    ...bound,
    allowExit: [0],
    env: { GIT_OPTIONAL_LOCKS: "0" },
    stripFinalNewline: false,
  });
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("S "))
    .map((entry) => entry.slice(2));
}
