import { opendir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { redactAndClean } from "./test-cmd.mjs";

const MAX_ENTRIES = 20;
// A directory with more entries than this is not read, so the read stays bounded in size.
const SCAN_LIMIT = 10_000;
// The read stops waiting after this long, so a slow or hung store never holds a turn.
const READ_BOUND_MS = 5_000;
// Directories of a store version directory whose entry names are compared. `files` is left out:
// it holds the package content, one directory per hash prefix, and an install shows in the others.
const WATCHED_DIRS = ["links", "projects"];
const VERSION_DIR = /^v\d+$/;

// Lists carried by a fatal error that cannot take the property.
const carriedEntries = new WeakMap();

/**
 * Resolves the pnpm store root without starting pnpm: `npm_config_store_dir`, else the default of
 * the platform. A `store-dir` that only `.npmrc` or `pnpm-workspace.yaml` sets is not seen.
 */
// known-limit: a store set only in a pnpm config file reads as absent, so no field is reported
function packageStoreRoot() {
  const configured = process.env.npm_config_store_dir;
  if (configured) return configured;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pnpm", "store");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "pnpm", "store");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pnpm", "store");
}

async function readNames(dir, scanLimit) {
  const names = [];
  let handle;
  try {
    handle = await opendir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return names;
    throw err;
  }
  for await (const entry of handle) {
    if (names.length >= scanLimit) throw new Error(`more than ${scanLimit} entries in ${dir}`);
    names.push(entry.name);
  }
  return names;
}

async function readStore(root, scanLimit) {
  const signatures = new Map();
  for (const version of (await readdir(root)).filter((name) => VERSION_DIR.test(name))) {
    // Size and modification time only: the index file is a database that any install rewrites.
    try {
      const { size, mtimeMs } = await stat(join(root, version, "index.db"));
      signatures.set(`${version}/index.db`, `${size}:${mtimeMs}`);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    for (const dir of WATCHED_DIRS) {
      for (const name of await readNames(join(root, version, dir), scanLimit)) {
        signatures.set(`${version}/${dir}/${name}`, "");
      }
    }
  }
  return signatures;
}

/**
 * Reads the names of the pnpm store entries that an install changes, with a signature each, or
 * null, after a warning, when the store cannot be read in time and size. A host with no store
 * reads as null without a warning. Reads names, sizes, and times only, never file content.
 * @returns {Promise<Map<string, string> | null>}
 */
export async function snapshotPackageStore({ scanLimit = SCAN_LIMIT } = {}) {
  const root = packageStoreRoot();
  let timer;
  try {
    const bound = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`read took over ${READ_BOUND_MS} ms`)),
        READ_BOUND_MS,
      );
      timer.unref();
    });
    return await Promise.race([readStore(root, scanLimit), bound]);
  } catch (err) {
    if (err?.code === "ENOENT") {
      logDebug("package store not found");
    } else {
      logWarn(`package store not read: ${firstErrorLine(readableErrorText(err))}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Names the package store entries that appeared, changed, or vanished since `before`, sorted, at
 * most 20, each redacted like the test command output (ADR 0017), because a name is chosen by the
 * turn. The names are advisory only: the store is shared with every other process on the host,
 * so the runtime cannot attribute a change to the turn and never reverts one (issue #1045).
 * Returns [] when either read failed.
 * @param {Map<string, string> | null} before
 * @returns {Promise<string[]>}
 */
export async function changedInPackageStore(before) {
  if (before === null) return [];
  const after = await snapshotPackageStore();
  if (after === null) return [];
  const names = new Set();
  for (const [name, signature] of after) if (before.get(name) !== signature) names.add(name);
  for (const name of before.keys()) if (!after.has(name)) names.add(name);
  return [...new Set([...names].sort().slice(0, MAX_ENTRIES).map(redactAndClean))];
}

/**
 * Carries the list on a fatal error as `err.packageStoreEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through `failedPackageStoreEntries`.
 */
export function carryPackageStoreEntries(err, entries) {
  carriedEntries.set(err, entries);
  try {
    err.packageStoreEntries = entries;
  } catch {}
}

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export function failedPackageStoreEntries(err) {
  return carriedEntries.get(err);
}
