import { join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { entryCarrier } from "./entry-report.mjs";
import { logWarn } from "./log.mjs";
import { sha256File, workTreeRoot } from "./snapshot.mjs";

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

/**
 * Reads the content hash of each lockfile at the work tree root of `cwd`, or null, after a warning,
 * when the read fails or does not end within `boundMs`. An absent lockfile reads as null, so a
 * lockfile that a turn adds or deletes differs from the earlier read. The read has its own time
 * bound and takes no turn signal, so a canceled turn is read too and the read never changes the
 * cancel outcome.
 * known-limit: a file read that stalls past the bound stays pending in the background.
 * @param {{ boundMs?: number }} [options]
 * @returns {Promise<Record<string, string | null> | null>}
 */
export async function readLockfiles(cwd, { boundMs = READ_BOUND_MS } = {}) {
  const bound = new AbortController();
  const timer = setTimeout(
    () => bound.abort(new Error(`lockfile read took over ${boundMs} ms`)),
    boundMs,
  );
  timer.unref();
  const stopped = new Promise((_, reject) => {
    bound.signal.addEventListener("abort", () => reject(bound.signal.reason), { once: true });
  });
  stopped.catch(() => {});
  try {
    const read = (async () => {
      const root = await workTreeRoot(cwd, { signal: bound.signal, timeoutMs: boundMs });
      const hashes = await Promise.all(LOCKFILES.map((name) => sha256File(join(root, name))));
      return Object.fromEntries(LOCKFILES.map((name, i) => [name, hashes[i]]));
    })();
    read.catch(() => {});
    return await Promise.race([read, stopped]);
  } catch (err) {
    logWarn(`worker: the lockfile read failed: ${firstErrorLine(readableErrorText(err))}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names the lockfiles that differ between two `readLockfiles` results, by path only. Sorted.
 * Returns [] when either read failed, so an unread state never reads as a change.
 */
export function diffLockfiles(before, after) {
  if (!before || !after) return [];
  return LOCKFILES.filter((name) => before[name] !== after[name]).sort();
}

const carrier = entryCarrier("lockfileChanged");

/**
 * Carries the paths on a fatal error as `err.lockfileChanged`. A frozen error or a throwing setter
 * keeps the original error, and the paths stay readable through `failedLockfileChanged`.
 */
export const carryLockfileChanged = carrier.carry;

/** Returns the paths a fatal error carries, or `undefined` when it carries none. */
export const failedLockfileChanged = carrier.failed;
