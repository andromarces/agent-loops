import { join } from "node:path";
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

/**
 * Reads the content hash of each lockfile at the work tree root of `cwd`. An absent lockfile reads
 * as null, so a lockfile that a turn adds or deletes differs from the earlier read. `bound` takes
 * `signal` and `timeoutMs`, as for `snapshot`.
 * @returns {Promise<Record<string, string | null>>}
 */
export async function readLockfiles(cwd, bound) {
  const root = await workTreeRoot(cwd, bound);
  const hashes = await Promise.all(LOCKFILES.map((name) => sha256File(join(root, name))));
  return Object.fromEntries(LOCKFILES.map((name, i) => [name, hashes[i]]));
}

/** Names the lockfiles that differ between two `readLockfiles` results, by path only. Sorted. */
export function diffLockfiles(before, after) {
  return LOCKFILES.filter((name) => before[name] !== after[name]).sort();
}
