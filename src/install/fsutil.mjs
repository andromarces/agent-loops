// Filesystem helpers for the user-scope installer (#139). Every write is atomic
// (temp file plus rename).
import { access, lstat, mkdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.mjs";

/**
 * Reads a file as UTF-8; returns null when the path does not exist. With
 * `notDirIsMissing`, a path whose parent is not a directory (ENOTDIR on POSIX)
 * also reads as null. Uninstall sets it so a stale record can clear. Install
 * leaves it off so an unusable location still fails before any write. Every
 * other error, such as EACCES or EPERM, throws.
 */
export async function readTextOrNull(path, { notDirIsMissing = false } = {}) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" || (notDirIsMissing && err.code === "ENOTDIR")) {
      return null;
    }
    throw err;
  }
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The permission bits of a file, or null when it does not exist. */
export async function fileMode(path) {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Exclusive `writeFileAtomic` that preserves the destination's permission bits unless `mode` is given, so a
 * private settings file stays private after install, backup, and restore (#790).
 */
export async function writeTextAtomic(path, text, { mode } = {}) {
  await writeFileAtomic(path, text, {
    mode: mode ?? (await fileMode(path)) ?? undefined,
    exclusive: true,
  });
}

export async function removeFileQuiet(path) {
  await rm(path, { force: true });
}

/**
 * Removes an empty directory. A missing directory and a non-empty directory
 * throw nothing, including the EEXIST that some platforms report for a
 * non-empty directory. Every other error, such as EPERM, EACCES, or EBUSY,
 * reaches the caller so it can report the failure and retry later.
 * @returns {Promise<boolean>} true when this call removed the directory
 */
export async function removeDirQuiet(path) {
  try {
    await rmdir(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST") {
      // A non-empty or already-removed directory needs no action.
      return false;
    }
    throw err;
  }
}

/**
 * Creates `dir` and every missing ancestor, recording each directory that did
 * not exist before so uninstall can prune exactly what install created.
 * @param {string} dir
 * @param {Set<string>} created receives every newly created directory
 */
export async function ensureDir(dir, created) {
  const missing = [];
  let current = resolve(dir);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (missing.length === 0) {
    return;
  }
  await mkdir(dir, { recursive: true });
  // Record shallow to deep so uninstall can remove deepest first.
  for (const path of missing.reverse()) {
    created.add(path);
  }
}

/**
 * Removes empty directories, deepest first. Missing and non-empty entries are
 * ignored. A path that is no longer a directory is left in place and listed in
 * `notDirs`, so a retry does not fail on it forever. An `lstat` decides this
 * before `rmdir`, because Windows reports ENOENT, not ENOTDIR, for a regular
 * file. Any other error propagates to the caller.
 * @returns {Promise<{removed: string[], notDirs: string[]}>} the directories
 *   this call removed and the paths it left in place as non-directories
 */
export async function pruneEmptyDirs(dirs) {
  const ordered = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  const removed = [];
  const notDirs = [];
  for (const dir of ordered) {
    try {
      const entry = await lstat(dir).catch((err) =>
        err.code === "ENOENT" ? null : Promise.reject(err),
      );
      if (entry && !entry.isDirectory()) {
        notDirs.push(dir);
      } else if (await removeDirQuiet(dir)) {
        removed.push(dir);
      }
    } catch (err) {
      if (err.code !== "ENOTDIR") {
        throw err;
      }
      notDirs.push(dir);
    }
  }
  return { removed, notDirs };
}

export function backupPathFor(path) {
  return `${path}.agent-loops-backup`;
}
