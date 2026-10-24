import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { redactAndClean } from "./test-cmd.mjs";
import { isTurnTmpdirName } from "./turn-tmpdir.mjs";

const MAX_ENTRIES = 20;

// Lists carried by a fatal error that cannot take the property.
const carriedEntries = new WeakMap();

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
 * sorted, at most 20, each redacted like the test command output (ADR 0017), because a name is
 * chosen by the turn. The directories that this process created for a turn are left out by their
 * exact name, because the runtime removes them. Any other name is reported, an `al-` name too. The
 * names are advisory only: the directory is shared with every other process on the host, so the
 * runtime cannot attribute an entry to the turn and never deletes one (issue #1024). Returns []
 * when either read failed.
 * @param {Set<string> | null} before
 * @returns {Promise<string[]>}
 */
export async function appearedInInheritedTmpdir(before) {
  if (before === null) return [];
  const after = await snapshotInheritedTmpdir();
  if (after === null) return [];
  const names = [...after].filter((name) => !before.has(name) && !isTurnTmpdirName(name)).sort();
  return [...new Set(names.slice(0, MAX_ENTRIES).map(redactAndClean))];
}

/**
 * Carries the list on a fatal error as `err.inheritedTmpdirEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through
 * `failedInheritedTmpdirEntries`.
 */
export function carryInheritedTmpdirEntries(err, entries) {
  carriedEntries.set(err, entries);
  try {
    err.inheritedTmpdirEntries = entries;
  } catch {}
}

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export function failedInheritedTmpdirEntries(err) {
  return carriedEntries.get(err);
}
