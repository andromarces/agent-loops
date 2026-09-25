// Filesystem and comparison helpers for the user-scope installer (#139).
// Every write is atomic (temp file plus rename) and every hash is SHA-256 over
// the UTF-8 bytes, so the manifest can prove equality with what it last wrote.
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reads a file as UTF-8; returns null when the path does not exist. */
export async function readTextOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
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
 * Writes through a temp file in the same directory, then renames. Preserves the
 * destination's permission bits unless `mode` is given, so a private settings
 * file stays private after install, backup, and restore. The temp file is
 * created with that mode, so it is never briefly world-readable.
 */
export async function writeTextAtomic(path, text, { mode } = {}) {
  const temp = `${path}.${process.pid}.tmp`;
  const targetMode = mode ?? (await fileMode(path));
  await writeFile(temp, text, { encoding: "utf8", mode: targetMode ?? 0o666 });
  if (targetMode !== null && process.platform !== "win32") {
    await chmod(temp, targetMode);
  }
  await rename(temp, path);
}

export async function removeFileQuiet(path) {
  await rm(path, { force: true });
}

/** Removes an empty directory; a non-empty or missing directory throws nothing. */
export async function removeDirQuiet(path) {
  try {
    await rmdir(path);
  } catch {
    // A non-empty or already-removed directory needs no action.
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

/** Removes empty directories, deepest first. Non-empty and missing entries are ignored. */
export async function pruneEmptyDirs(dirs) {
  const ordered = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    await removeDirQuiet(dir);
  }
}

/** Structural equality for JSON-shaped values. Object key order is irrelevant. */
export function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

export function backupPathFor(path) {
  return `${path}.agent-loops-backup`;
}
