import { opendir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { redactAndClean } from "./test-cmd.mjs";

const MAX_ENTRIES = 20;
// A directory with more entries than this is not read, so the read stays bounded in size. The
// limit covers every directory read, the store root included.
const SCAN_LIMIT = 10_000;
// The whole read, the config file checks included, ends at this bound. The traversal checks it
// before each file system call, so it starts no call after the bound.
const READ_BOUND_MS = 5_000;
// A config file larger than this cannot be ruled out, so the store counts as unknown.
const MAX_CONFIG_BYTES = 1 << 20;
// Directories of a store version directory whose entry names are compared. `files` is left out:
// it holds the package content, one directory per hash prefix, and an install shows in the others.
const WATCHED_DIRS = ["links", "projects"];
const VERSION_DIR = /^v\d+$/;
// A `store-dir` line of an rc file, or a `storeDir` key of `pnpm-workspace.yaml`.
const STORE_SETTING = /^\s*["']?(?:store[-_]dir|storeDir)["']?\s*[=:]/im;

// Lists carried by a fatal error that cannot take the property.
const carriedEntries = new WeakMap();

/** The value of an environment variable, matched by name without regard to case. */
const envValue = (name) =>
  Object.entries(process.env).find(([key]) => key.toLowerCase() === name)?.[1] || undefined;

/** Config files, other than the work tree ones, in which pnpm can set `store-dir`. */
function userConfigFiles() {
  const home = homedir();
  const files = [join(home, ".npmrc")];
  for (const name of ["npm_config_userconfig", "npm_config_globalconfig"]) {
    const value = envValue(name);
    if (value) files.push(value);
  }
  // The npm global config sits under the prefix of the running Node.js.
  const prefix =
    process.platform === "win32" ? dirname(process.execPath) : dirname(dirname(process.execPath));
  files.push(join(prefix, "etc", "npmrc"));
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    files.push(join(local, "pnpm", "config", "rc"));
  } else if (process.platform === "darwin") {
    files.push(join(home, "Library", "Preferences", "pnpm", "rc"));
  } else {
    files.push(join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "pnpm", "rc"));
  }
  return files;
}

/** The `.npmrc` and `pnpm-workspace.yaml` paths of a work tree and each of its parents. */
function workTreeConfigFiles(cwd) {
  const files = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    files.push(join(dir, ".npmrc"), join(dir, "pnpm-workspace.yaml"));
    if (dirname(dir) === dir) return files;
  }
}

/** True when a config file sets a store, or cannot be read, so it might. A missing file does not. */
async function setsStore(file, signal) {
  signal.throwIfAborted();
  try {
    if ((await stat(file)).size > MAX_CONFIG_BYTES) return true;
    signal.throwIfAborted();
    return STORE_SETTING.test(await readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false;
    if (signal.aborted) throw err;
    return true;
  }
}

/**
 * Resolves the pnpm store root of a work tree without starting pnpm, or null when it cannot be
 * known. `npm_config_store_dir` wins, as it does in pnpm. Otherwise the default of the platform
 * is used, only when no config file that can set `store-dir` does, and only when the work tree is
 * on the device of the home directory, since pnpm puts the store of another device elsewhere. A
 * wrong root must never produce a report, so any doubt gives null.
 */
// known-limit: a `--store-dir` flag and a config file outside the listed locations are not seen
async function packageStoreRoot(cwd, signal) {
  const configured = envValue("npm_config_store_dir") ?? envValue("npm_config_store-dir");
  if (configured) return configured;
  for (const file of [...workTreeConfigFiles(cwd), ...userConfigFiles()]) {
    if (await setsStore(file, signal)) return null;
  }
  signal.throwIfAborted();
  const home = homedir();
  if ((await stat(cwd)).dev !== (await stat(home)).dev) return null;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "pnpm", "store");
  }
  if (process.platform === "darwin") return join(home, "Library", "pnpm", "store");
  return join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "pnpm", "store");
}

async function readNames(dir, scanLimit, signal) {
  const names = [];
  signal.throwIfAborted();
  let handle;
  try {
    handle = await opendir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return names;
    throw err;
  }
  for await (const entry of handle) {
    signal.throwIfAborted();
    if (names.length >= scanLimit) throw new Error(`more than ${scanLimit} entries in ${dir}`);
    names.push(entry.name);
  }
  return names;
}

async function readStore(root, scanLimit, signal) {
  const signatures = new Map();
  const versions = (await readNames(root, scanLimit, signal)).filter((name) =>
    VERSION_DIR.test(name),
  );
  for (const version of versions) {
    // Size and modification time only: the index file is a database that any install rewrites.
    try {
      signal.throwIfAborted();
      const { size, mtimeMs } = await stat(join(root, version, "index.db"));
      signatures.set(`${version}/index.db`, `${size}:${mtimeMs}`);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    for (const dir of WATCHED_DIRS) {
      for (const name of await readNames(join(root, version, dir), scanLimit, signal)) {
        signatures.set(`${version}/${dir}/${name}`, "");
      }
    }
  }
  return signatures;
}

/**
 * Reads the names of the pnpm store entries that an install changes, with a signature each, or
 * null, after a warning, when the store cannot be read in time and size. Null without a warning
 * when the root is unknown (see `packageStoreRoot`) or when `signal` aborts. A missing store reads
 * as empty. Reads names, sizes, and times only, never store file content. A config file is read
 * for a `store-dir` line only, and nothing of it is kept.
 * `boundMs` ends the traversal itself: no file system call starts after it.
 * @param {{ cwd?: string, signal?: AbortSignal, scanLimit?: number, boundMs?: number }} [options]
 * @returns {Promise<Map<string, string> | null>}
 */
export async function snapshotPackageStore({
  cwd = process.cwd(),
  signal,
  scanLimit = SCAN_LIMIT,
  boundMs = READ_BOUND_MS,
} = {}) {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(new Error(`read took over ${boundMs} ms`)), boundMs);
  timer.unref();
  const stop = signal ? AbortSignal.any([signal, bound.signal]) : bound.signal;
  // A call in flight cannot be canceled, so the wait ends at the bound too.
  const stopped = new Promise((_, reject) => {
    stop.addEventListener("abort", () => reject(stop.reason), { once: true });
  });
  stopped.catch(() => {});
  try {
    const read = (async () => {
      const root = await packageStoreRoot(cwd, stop);
      if (root === null) {
        logDebug("package store root not known");
        return null;
      }
      return readStore(root, scanLimit, stop);
    })();
    read.catch(() => {});
    return await Promise.race([read, stopped]);
  } catch (err) {
    if (signal?.aborted) {
      logDebug("package store read stopped by cancel");
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
 * @param {{ cwd?: string, signal?: AbortSignal }} [options] as for `snapshotPackageStore`
 * @returns {Promise<string[]>}
 */
export async function changedInPackageStore(before, options) {
  if (before === null) return [];
  const after = await snapshotPackageStore(options);
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
