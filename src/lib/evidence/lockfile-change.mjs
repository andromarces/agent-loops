import { join } from "node:path";
import { DEFAULT_BATCH_SIZE, mapInBatches } from "../batches.mjs";
import { errorCode, errorLine } from "../error-message.mjs";
import { reportedPathNames } from "./entry-report.mjs";
import { gitRead } from "../git-read.mjs";
import { logWarn } from "../log.mjs";
import { sha256File, workTreeRoot } from "../snapshot.mjs";
import { withTimeBound } from "../time-bound.mjs";

// Lockfiles of the common package managers, at the work tree root.
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

// Non-Node dependency files, matched by file name at any depth.
const DEPENDENCY_NAMES = new Set([
  "Pipfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
]);
const DEPENDENCY_PATTERN = /^(?:requirements|constraints).*\.txt$/;

// Has at most 256 non-Node dependency files. A longer list reports the rest as changed, so a
// capped read never hides a change.
const MAX_DEPENDENCY_FILES = 256;
// The whole read ends at this bound, root discovery, listing, and hashing together.
const READ_BOUND_MS = 10_000;
// Marks a dependency file whose hash is unreadable in time.
const UNREADABLE = "unreadable";
// Marks a read whose dependency file list failed. `diffLockfiles` then reports every known
// non-Node path, so a failed list never reads as no change.
const LIST_FAILED = Symbol("lockfileListFailed");

const isDependencyFile = (name) => DEPENDENCY_NAMES.has(name) || DEPENDENCY_PATTERN.test(name);

// Reads the tracked and untracked, non-ignored dependency file paths, root-relative with "/".
async function listDependencyFiles(root, bound) {
  const result = await gitRead(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { signal: bound.signal, timeoutMs: READ_BOUND_MS, allowExit: [0] },
  );
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => isDependencyFile(path.slice(path.lastIndexOf("/") + 1)))
    .sort();
}

// A record that reports every root lockfile as changed and marks the list read as failed.
function failedRecord() {
  const record = Object.fromEntries(LOCKFILES.map((name) => [name, UNREADABLE]));
  Object.defineProperty(record, LIST_FAILED, { value: true });
  return record;
}

/**
 * Reads the content hash of the root Node lockfiles and of every matching non-Node dependency file.
 * The dependency file list comes from one Git read that skips ignored paths. An absent root lockfile
 * reads as null, so an added or deleted lockfile differs from the earlier read. A failed or timed-out
 * list read reports every Node lockfile as unreadable, and `diffLockfiles` reports every known
 * non-Node path. A hash read failure or timeout reports that file as unreadable, which
 * `diffLockfiles` reports. The read has its own time bound and takes no turn signal.
 * @param {{ boundMs?: number }} [options]
 * @returns {Promise<Record<string, string | null>>}
 */
export async function readLockfiles(cwd, { boundMs = READ_BOUND_MS } = {}) {
  // The read takes no turn signal, so a canceled turn is read too and the cancel outcome does not change.
  // known-limit: the bound ends the wait, not a request already in flight, so a stalled read can keep its handle.
  // No portable test produces a stalled request, so bounded handle release is unproven.
  return withTimeBound(boundMs, `lockfile read took over ${boundMs} ms`, async (bound) => {
    const hash = async (root, relPath) => {
      const rootLockfile = LOCKFILES.includes(relPath);
      try {
        return await Promise.race([
          sha256File(join(root, ...relPath.split("/")), { signal: bound.signal }),
          bound.stopped,
        ]);
      } catch (err) {
        // A file system error message carries the path, so the warning names the error code only.
        const code = errorCode(err);
        const reason = bound.signal.aborted ? `over ${boundMs} ms` : code || "unknown error";
        const subject = rootLockfile ? `the lockfile ${relPath}` : "a dependency file";
        logWarn(`worker: ${subject} read failed (${reason}); reporting it as changed`);
        return UNREADABLE;
      }
    };
    try {
      // The root read carries READ_BOUND_MS as its own backstop, so a shorter caller bound ends it through the signal.
      const root = await Promise.race([
        workTreeRoot(cwd, { signal: bound.signal, timeoutMs: READ_BOUND_MS }),
        bound.stopped,
      ]);
      // One bounded list read includes tracked and untracked files and skips ignored paths.
      let candidates;
      try {
        const pending = listDependencyFiles(root, bound);
        pending.catch(() => {});
        candidates = await Promise.race([pending, bound.stopped]);
      } catch {
        logWarn(
          "worker: the dependency file list read failed; reporting every dependency file as changed",
        );
        return failedRecord();
      }
      const hashed = candidates.slice(0, MAX_DEPENDENCY_FILES);
      const overflow = candidates.slice(MAX_DEPENDENCY_FILES);
      if (overflow.length > 0) {
        logWarn(
          `worker: ${candidates.length} dependency files exceed ${MAX_DEPENDENCY_FILES}; reporting the rest as changed`,
        );
      }
      const [nodeHashes, fileHashes] = await Promise.all([
        Promise.all(LOCKFILES.map((name) => hash(root, name))),
        mapInBatches(hashed, DEFAULT_BATCH_SIZE, (path) => hash(root, path)),
      ]);
      return Object.fromEntries([
        ...LOCKFILES.map((name, i) => [name, nodeHashes[i]]),
        ...hashed.map((path, i) => [path, fileHashes[i]]),
        ...overflow.map((path) => [path, UNREADABLE]),
      ]);
    } catch (err) {
      logWarn(
        `worker: the lockfile read failed: ${errorLine(err)}; reporting every lockfile as changed`,
      );
      return failedRecord();
    }
  });
}

/**
 * Names the dependency files that differ between two `readLockfiles` results, by path only. Sorted.
 * A file that is unreadable in either result counts as changed. A reinstall is harmless, and a
 * missed one leaves the next reviewer on stale dependencies. When either read failed its file list,
 * every Node lockfile and every non-Node path known from either result counts as changed. Returns []
 * when a result is missing, which is a turn that took no read.
 */
export function diffLockfiles(before, after) {
  if (!before || !after) return [];
  const listFailed = before[LIST_FAILED] === true || after[LIST_FAILED] === true;
  const node = LOCKFILES.filter(
    (name) =>
      before[name] !== after[name] || before[name] === UNREADABLE || after[name] === UNREADABLE,
  );
  const paths = new Set([
    ...Object.keys(before).filter((path) => !LOCKFILES.includes(path)),
    ...Object.keys(after).filter((path) => !LOCKFILES.includes(path)),
  ]);
  const nonNode = [...paths].filter(
    (path) =>
      listFailed ||
      before[path] !== after[path] ||
      before[path] === UNREADABLE ||
      after[path] === UNREADABLE,
  );
  return [...new Set([...node, ...nonNode])].sort();
}

/**
 * Names the changed paths for the envelope, redacted like the other path fields. A fixed root
 * lockfile name stays byte-identical, because the turn does not choose it.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function reportedLockfilePaths(paths) {
  return reportedPathNames(paths, (path) => LOCKFILES.includes(path));
}
