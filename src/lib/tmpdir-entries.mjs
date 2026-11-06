import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { mapInBatches } from "./batches.mjs";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { isTurnTmpdirName } from "./turn-tmpdir.mjs";
import { isRegisteredTurnTmpdir } from "./turn-tmpdir-registry.mjs";
import { withTimeBound } from "./time-bound.mjs";

const REGISTERED_PREFIX = "registered/";
const READ_BATCH_SIZE = 32;
// A later read answers in milliseconds. The bound ends a read that hangs, and a read that reaches
// the bound keeps every recorded name (issue #1559).
const RE_READ_BOUND_MS = 5_000;
// A recorded name that holds one of these cannot name a direct entry, so the read keeps it.
const UNSAFE_NAME = /[/\\\0]/;
const REDACTED_NAME = /\[redacted:|\[\*\]/;
// A transient file, such as a GUID `.tmp` file, can be in the post-turn read and then be gone a
// moment later. The second read after this window keeps only the entries that still exist (issue
// #1542).
const SETTLE_MS = 250;

// Reads `os.tmpdir()` of this process, which is the inherited temporary directory of a turn. The
// `AGENT_LOOP_INHERITED_TMPDIR` list is read in `inherited-tmpdir.mjs`.

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
 * exact name, because the runtime removes them. Every other entry is listed, an `al-` name too. An
 * entry that is the turn directory that another agent-loop process registered carries the prefix
 * `registered/`, which no entry name can hold, so the parent can tell it apart (issue #1240). The
 * mark is a hint and never a reason to leave an entry out: a turn can write a registration too
 * (ADR 0069). A name that a second read after a short settle no longer holds is left out; the reads
 * establish no owner. A failed second read keeps it, since the list is advisory (issue #1542). The
 * names are advisory only: the directory is shared with every other process on the host, so the
 * runtime cannot attribute an entry to the turn and never deletes one (issue #1024). Returns [] when
 * either of the first two reads failed.
 * @param {Set<string> | null} before
 * @param {{ settle?: () => Promise<void> }} [options] `settle` replaces the default wait before the
 *   confirming read.
 * @returns {Promise<string[]>}
 */
export async function appearedInInheritedTmpdir(before, { settle = waitToSettle } = {}) {
  if (before === null) return [];
  const after = await snapshotInheritedTmpdir();
  if (after === null) return [];
  const appeared = [...after].filter((name) => !before.has(name) && !isTurnTmpdirName(name));
  if (appeared.length === 0) return [];
  const confirmed = await entriesAfterSettle(appeared, settle);
  if (confirmed.length === 0) return [];
  const parent = tmpdir();
  const registered = await mapInBatches(confirmed, READ_BATCH_SIZE, (name) =>
    isRegisteredTurnTmpdir(parent, name),
  );
  return reportedEntryNames(
    confirmed.map((name, i) => (registered[i] ? `${REGISTERED_PREFIX}${name}` : name)),
  );
}

async function waitToSettle() {
  await delay(SETTLE_MS);
}

// The names of `names` that a further read still holds after `settle`. A failed read keeps every
// name.
async function entriesAfterSettle(names, settle) {
  await settle();
  const settled = await snapshotInheritedTmpdir();
  return settled === null ? names : names.filter((name) => settled.has(name));
}

const carrier = entryCarrier("inheritedTmpdirEntries");

/**
 * Re-reads the inherited temporary directory and returns the recorded names that it still holds,
 * in the recorded order. A name that the read cannot check stays listed: a redacted name, one with
 * a separator or `..`, and every name after a failed or over-bound read. The read lists names
 * only, deletes nothing, and follows no link. It returns [] when no name was recorded.
 * @param {Iterable<string>} names the names that the reviewer turns reported
 * @param {{ read?: () => Promise<string[]>, boundMs?: number }} [options] `read` replaces the
 *   directory read, so a test fixes the order without a wall-clock wait.
 * @returns {Promise<string[]>}
 */
export async function presentInheritedTmpdir(
  names,
  { read = readInheritedTmpdirNames, boundMs = RE_READ_BOUND_MS } = {},
) {
  const recorded = [...new Set(names)].filter((name) => typeof name === "string" && name !== "");
  if (recorded.length === 0) return [];
  let entries;
  try {
    entries = await withTimeBound(
      boundMs,
      `inherited temporary directory re-read took over ${boundMs} ms`,
      ({ stopped }) => {
        // The read cannot be canceled, so the wait ends at the bound too.
        const pending = read();
        pending.catch(() => {});
        return Promise.race([pending, stopped]);
      },
    );
  } catch (err) {
    logWarn(`inherited temporary directory not re-read: ${firstErrorLine(readableErrorText(err))}`);
    return recorded;
  }
  if (!Array.isArray(entries)) return recorded;
  const present = new Set(entries);
  return recorded.filter((name) => stillHeld(name, present));
}

async function readInheritedTmpdirNames() {
  return readdir(tmpdir());
}

// Whether a further read still holds `name`. A name that cannot be checked stays present, because
// a lost name can hide a leftover.
function stillHeld(name, present) {
  const bare = name.startsWith(REGISTERED_PREFIX) ? name.slice(REGISTERED_PREFIX.length) : name;
  if (bare === "" || bare === "." || bare === "..") return true;
  if (UNSAFE_NAME.test(bare) || REDACTED_NAME.test(bare)) return true;
  return present.has(bare);
}

/**
 * Carries the list on a fatal error as `err.inheritedTmpdirEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through
 * `failedInheritedTmpdirEntries`.
 */
export const carryInheritedTmpdirEntries = carrier.carry;

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export const failedInheritedTmpdirEntries = carrier.failed;
