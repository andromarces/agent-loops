import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { mainWorkTreePath } from "./local-files.mjs";
import { logWarn } from "./log.mjs";
import { snapshot } from "./snapshot.mjs";
import { withTimeBound } from "./time-bound.mjs";

// Whole-read bound, including main work tree resolution and content hashing.
const READ_BOUND_MS = 10_000;

/**
 * Reads the tracked and untracked, unignored state of the main work tree that a linked `cwd` belongs
 * to. Returns a map of path to status and content hash. The map is null when `cwd` is the main work
 * tree, the layout has none, or the read fails or passes its bound. The read takes no optional Git
 * lock, so it never writes the index. A failed read warns, and an absent map then proves nothing.
 * @param {string} cwd
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<Map<string, string> | null>}
 */
export async function readMainWorkTree(cwd, { deadlineMs = READ_BOUND_MS } = {}) {
  try {
    return await withTimeBound(
      deadlineMs,
      `the main work tree read took over ${deadlineMs} ms`,
      async ({ signal, stopped }) => {
        const main = await Promise.race([mainWorkTreePath(cwd, { signal }), stopped]);
        if (main === null) return null;
        const snap = await Promise.race([
          snapshot(main, { signal, timeoutMs: deadlineMs, env: { GIT_OPTIONAL_LOCKS: "0" } }),
          stopped,
        ]);
        return new Map(snap.workTree.map((entry) => [entry.path, stateOf(entry)]));
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

/**
 * Names the paths that differ between two `readMainWorkTree` maps, by path relative to the main work
 * tree. A dirty path that changes again differs, and one left unchanged does not. Returns [] when
 * either read is missing, at most 20 names, and never content.
 * @param {Map<string, string> | null} before
 * @param {Map<string, string> | null} after
 * @returns {string[]}
 */
export function diffMainWorkTree(before, after) {
  if (!before || !after) return [];
  const changed = [];
  for (const [path, state] of before) {
    if (after.get(path) !== state) changed.push(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed.push(path);
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
