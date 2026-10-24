import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { TURN_TMPDIR_PREFIX } from "./turn-tmpdir.mjs";

const MAX_ENTRIES = 20;

/**
 * Reads the entry names directly in the inherited temporary directory, or null, after a warning,
 * when it cannot be read.
 * @returns {Promise<Set<string> | null>}
 */
export async function snapshotInheritedTmpdir() {
  try {
    return new Set(await readdir(tmpdir()));
  } catch (err) {
    logWarn(`inherited temporary directory not read: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  }
}

/**
 * Names the entries that appeared directly in the inherited temporary directory since `before`,
 * sorted, at most 20. Turn temporary directories are left out, because the runtime removes them and
 * a concurrent turn creates them. The names are advisory only: the directory is shared with every
 * other process on the host, so the runtime cannot attribute an entry to the turn and never
 * deletes one (issue #1024). Returns [] when either read failed.
 * @param {Set<string> | null} before
 * @returns {Promise<string[]>}
 */
export async function appearedInInheritedTmpdir(before) {
  if (before === null) return [];
  const after = await snapshotInheritedTmpdir();
  if (after === null) return [];
  return [...after]
    .filter((name) => !before.has(name) && !name.startsWith(TURN_TMPDIR_PREFIX))
    .sort()
    .slice(0, MAX_ENTRIES);
}
