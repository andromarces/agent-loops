import { readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mapInBatches } from "./batches.mjs";
import { errorLine } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { isTurnTmpdirName } from "./turn-tmpdir.mjs";
import { isRegisteredTurnTmpdir } from "./turn-tmpdir-registry.mjs";

const REGISTERED_PREFIX = "registered/";
// A name of a literal system temporary directory that differs from the inherited one. No entry name
// can hold the slash, so the parent can tell the two reads apart (issue #1713).
const LITERAL_PREFIX = "literal-tmp/";
const READ_BATCH_SIZE = 32;

/**
 * The literal system temporary directories that a child can name without an environment variable.
 * POSIX names `/tmp`, and macOS names the same directory behind `/private/tmp`. Windows has none,
 * because a Git Bash `/tmp` resolves to the inherited directory, which the inherited read covers.
 * @returns {string[]}
 */
export function literalTmpdirRoots() {
  return process.platform === "win32" ? [] : ["/tmp", "/private/tmp"];
}

/**
 * The entry names of one temporary-directory read.
 * @typedef {object} TmpdirSnapshot
 * @property {Set<string> | null} inherited the names directly in the inherited temporary directory, or null when the caller reads only the literal roots
 * @property {Map<string, Set<string>>} literal each resolved literal root and its names
 */

/** The resolved path of `path`, or null when it does not resolve. */
async function resolvedPath(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** The names directly in `dir`, or null after a warning when the read fails for another reason than a missing directory. */
async function readRootNames(dir) {
  try {
    return new Set(await readdir(dir));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logWarn(`literal temporary directory not read: ${errorLine(err)}`);
    }
    return null;
  }
}

// Reads `os.tmpdir()` of this process, which is the inherited temporary directory of a turn. The
// `AGENT_LOOP_INHERITED_TMPDIR` list is read in `inherited-tmpdir.mjs`.

/**
 * Reads the entry names directly in the inherited temporary directory and in each literal root of
 * `literalRoots`, or null, after a warning, when the inherited directory cannot be read. A literal
 * root that does not resolve, that resolves to the inherited directory while that directory is read
 * too, or that repeats a root already read is left out. A root that holds the inherited directory is
 * read, so a write directly in it is still seen (issue #1713). A failed literal read adds no entry
 * for that root. `includeInherited` is false for a worker turn, which reports only the literal roots;
 * the snapshot then holds no inherited names, and a root equal to the inherited directory is read as
 * a literal root because the two writes cannot be told apart.
 * @param {{ literalRoots?: string[], includeInherited?: boolean }} [options]
 * @returns {Promise<TmpdirSnapshot | null>}
 */
export async function snapshotInheritedTmpdir({
  literalRoots = literalTmpdirRoots(),
  includeInherited = true,
} = {}) {
  let inherited = null;
  if (includeInherited) {
    try {
      inherited = new Set(await readdir(tmpdir()));
    } catch (err) {
      logWarn(`inherited temporary directory not read: ${errorLine(err)}`);
      return null;
    }
  }
  const inheritedDir = (await resolvedPath(tmpdir())) ?? tmpdir();
  const literal = new Map();
  for (const root of literalRoots) {
    const resolved = await resolvedPath(root);
    if (resolved === null || (includeInherited && resolved === inheritedDir)) continue;
    if (literal.has(resolved)) continue;
    const rootNames = await readRootNames(resolved);
    if (rootNames !== null) literal.set(resolved, rootNames);
  }
  return { inherited, literal };
}

/**
 * Names the entries that appeared directly in the inherited temporary directory since `before` and,
 * when it lists literal roots, in each of them, sorted, at most 20, each redacted like the test
 * command output (ADR 0017), because a name is chosen by the turn. A literal entry carries the
 * prefix `literal-tmp/`, because a literal `/tmp` path on macOS is not the inherited directory and
 * no field named it (issue #1713). The directories that this process created for a turn are left
 * out by their exact name, because the runtime removes them. Every other entry is listed, an `al-`
 * name too. An entry that is the turn directory that another agent-loop process registered carries
 * the prefix `registered/`, which no entry name can hold, so the parent can tell it apart (issue
 * #1240). The mark is a hint and never a reason to leave an entry out: a turn can write a
 * registration too (ADR 0069). The read happens once, after the turn's last child call, with no
 * confirming read and no wait (issue #1616, ADR 0095). The names are diagnostics only: the
 * directories are shared with every other process on the host, so the runtime cannot attribute an
 * entry to the turn and never deletes one (issue #1024). An unattributed difference creates no
 * automatic `open` item. `includeInherited` is false for a worker turn, which may legitimately
 * write directly in the inherited directory; a literal root that is that directory is still read,
 * because the two writes cannot be told apart. Returns [] when either read failed.
 * @param {TmpdirSnapshot | null} before
 * @param {{ includeInherited?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
export async function appearedInInheritedTmpdir(before, { includeInherited = true } = {}) {
  if (before === null) return [];
  const diffInherited = includeInherited && before.inherited !== null;
  const after = await snapshotInheritedTmpdir({
    literalRoots: [...before.literal.keys()],
    includeInherited: diffInherited,
  });
  if (after === null) return [];
  const inheritedAppeared = diffInherited
    ? [...after.inherited].filter((name) => !before.inherited.has(name) && !isTurnTmpdirName(name))
    : [];
  const literalAppeared = [];
  for (const [root, afterNames] of after.literal) {
    const beforeNames = before.literal.get(root);
    if (beforeNames === undefined) continue;
    for (const name of afterNames) {
      if (beforeNames.has(name) || isTurnTmpdirName(name)) continue;
      literalAppeared.push(`${LITERAL_PREFIX}${name}`);
    }
  }
  if (inheritedAppeared.length === 0 && literalAppeared.length === 0) return [];
  const parent = tmpdir();
  const registered = await mapInBatches(inheritedAppeared, READ_BATCH_SIZE, (name) =>
    isRegisteredTurnTmpdir(parent, name),
  );
  return reportedEntryNames([
    ...inheritedAppeared.map((name, i) => (registered[i] ? `${REGISTERED_PREFIX}${name}` : name)),
    ...literalAppeared,
  ]);
}

const carrier = entryCarrier("inheritedTmpdirEntries");

/**
 * Carries the list on a fatal error as `err.inheritedTmpdirEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through
 * `failedInheritedTmpdirEntries`.
 */
export const carryInheritedTmpdirEntries = carrier.carry;

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export const failedInheritedTmpdirEntries = carrier.failed;
