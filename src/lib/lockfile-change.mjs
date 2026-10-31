import { join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { entryCarrier } from "./entry-report.mjs";
import { logWarn } from "./log.mjs";
import { sha256File, workTreeRoot } from "./snapshot.mjs";
import { withTimeBound } from "./time-bound.mjs";

// Lockfiles of the common package managers, at the work tree root.
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

// The whole read ends at this bound, root discovery and hashing together.
const READ_BOUND_MS = 10_000;
// Marks a lockfile whose hash could not be read in time. It is never a hash, and a lockfile that
// holds it on either side of a compare is reported as changed.
const UNREADABLE = "unreadable";

/**
 * Reads the content hash of each lockfile at the work tree root of `cwd`. An absent lockfile reads
 * as null, so a lockfile that a turn adds or deletes differs from the earlier read. A lockfile whose
 * hash fails or does not end within `boundMs` reads as unreadable after a warning, and
 * `diffLockfiles` reports it. When the work tree root cannot be read in time, every lockfile reads
 * as unreadable, so the parent reinstalls instead of reading a silent "no change". The read has its
 * own time bound and takes no turn signal, so a canceled turn is read too and the read never
 * changes the cancel outcome. The bound aborts the signal that each hash read takes, which stops a
 * read that has not yet started its file system request.
 * known-limit: the bound ends the wait, not a file system request already in flight. Node checks the
 * signal only between requests, so a stalled `lstat`, `readlink`, or content read stays pending after
 * the bound, can keep its file handle, and can keep the process alive. No test shows bounded handle
 * release, because a stalled request cannot be produced portably.
 * @param {{ boundMs?: number }} [options]
 * @returns {Promise<Record<string, string | null>>}
 */
export async function readLockfiles(cwd, { boundMs = READ_BOUND_MS } = {}) {
  return withTimeBound(boundMs, `lockfile read took over ${boundMs} ms`, async (bound) => {
    const hash = async (root, name) => {
      try {
        return await Promise.race([
          sha256File(join(root, name), { signal: bound.signal }),
          bound.stopped,
        ]);
      } catch (err) {
        // A file system error message carries the path, so the warning names the error code only.
        const code = typeof err?.code === "string" && /^[A-Z0-9_]+$/.test(err.code) ? err.code : "";
        const reason = bound.signal.aborted ? `over ${boundMs} ms` : code || "unknown error";
        logWarn(`worker: the lockfile ${name} read failed (${reason}); reporting it as changed`);
        return UNREADABLE;
      }
    };
    try {
      const root = await Promise.race([
        workTreeRoot(cwd, { signal: bound.signal, timeoutMs: boundMs }),
        bound.stopped,
      ]);
      const hashes = await Promise.all(LOCKFILES.map((name) => hash(root, name)));
      return Object.fromEntries(LOCKFILES.map((name, i) => [name, hashes[i]]));
    } catch (err) {
      logWarn(
        `worker: the lockfile read failed: ${firstErrorLine(readableErrorText(err))}; reporting every lockfile as changed`,
      );
      return Object.fromEntries(LOCKFILES.map((name) => [name, UNREADABLE]));
    }
  });
}

/**
 * Names the lockfiles that differ between two `readLockfiles` results, by path only. Sorted. A
 * lockfile that is unreadable in either result counts as changed, because a reinstall is harmless and
 * a missed one leaves the next reviewer on stale dependencies. Returns [] when a result is missing,
 * which is a turn that took no read.
 */
export function diffLockfiles(before, after) {
  if (!before || !after) return [];
  return LOCKFILES.filter(
    (name) =>
      before[name] !== after[name] || before[name] === UNREADABLE || after[name] === UNREADABLE,
  ).sort();
}

const carrier = entryCarrier("lockfileChanged");

/**
 * Carries the paths on a fatal error as `err.lockfileChanged`. A frozen error or a throwing setter
 * keeps the original error, and the paths stay readable through `failedLockfileChanged`.
 */
export const carryLockfileChanged = carrier.carry;

/** Returns the paths a fatal error carries, or `undefined` when it carries none. */
export const failedLockfileChanged = carrier.failed;
