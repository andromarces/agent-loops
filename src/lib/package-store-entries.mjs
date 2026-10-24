import { open, opendir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { redactAndClean } from "./test-cmd.mjs";

const MAX_ENTRIES = 20;
// A directory with more entries than this is not read, so the read stays bounded in size. The
// limit covers every directory read, the store root included.
const SCAN_LIMIT = 10_000;
// The whole read ends at this bound. Every file system call checks it before it starts, so no
// call starts after the bound.
const READ_BOUND_MS = 5_000;
// The recorded-store file is read up to this many bytes. A longer file counts as oversized.
const MAX_CONFIG_BYTES = 1 << 20;
// Directories of a store version directory whose entry names are compared. `files` is left out:
// it holds the package content, one directory per hash prefix, and an install shows in the others.
const WATCHED_DIRS = ["links", "projects"];
const VERSION_DIR = /^v\d+$/;
// The `storeDir` line of a `.modules.yaml` that is not JSON.
const STORE_DIR_LINE = /^\s*["']?storeDir["']?\s*:\s*(.+?)\s*,?\s*$/m;

// Lists carried by a fatal error that cannot take the property.
const carriedEntries = new WeakMap();

/** The value of an environment variable, matched by name without regard to case. */
const envValue = (name) =>
  Object.entries(process.env).find(([key]) => key.toLowerCase() === name)?.[1] || undefined;

/**
 * Reads a file as text up to `MAX_CONFIG_BYTES`, or returns null when it is longer. A growing file
 * is never read past the cap, whatever its size was before.
 */
async function readCapped(file, signal) {
  signal.throwIfAborted();
  const handle = await open(file, "r");
  try {
    const chunks = [];
    let total = 0;
    while (total <= MAX_CONFIG_BYTES) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65_536, MAX_CONFIG_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return total > MAX_CONFIG_BYTES ? null : Buffer.concat(chunks).toString("utf8");
  } finally {
    // The close of an opened handle is the one call that can follow the bound: a leaked
    // descriptor would be worse.
    await handle.close();
  }
}

/** The `storeDir` that pnpm recorded in the `.modules.yaml` text, or null when it names none. */
function recordedStoreDir(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.storeDir === "string" ? parsed.storeDir : null;
  } catch {}
  const value = STORE_DIR_LINE.exec(text)?.[1];
  if (!value) return null;
  try {
    if (value.startsWith('"')) return JSON.parse(value);
  } catch {
    return null;
  }
  return /^'.*'$/.test(value) ? value.slice(1, -1) : value;
}

/** The store root of a `storeDir` value, which names the version directory (`<root>/v11`). */
const storeRootOf = (cwd, dir) => {
  const path = resolve(cwd, dir);
  const root = VERSION_DIR.test(basename(path)) ? dirname(path) : path;
  return process.platform === "win32" ? root.toLowerCase() : root;
};

/**
 * Resolves the pnpm store root that the work tree uses, or null when it cannot be known. The root
 * is the `storeDir` that pnpm recorded in `node_modules/.modules.yaml` of the work tree on install,
 * read up to a byte cap. A missing, unreadable, oversized, or store-less file, or a path that is
 * not absolute, gives null: no guess at a default store. pnpm 12 reads `pnpm_config_store_dir` and
 * ignores `npm_config_store_dir`, and a later install with a changed store directory reinstalls
 * into it, so that variable, when set to another path than the recorded one, also gives null. A
 * wrong root must never produce a report.
 */
// known-limit: a work tree that never ran an install, or a `--store-dir` flag of a probe command,
// has no recorded store, so a change in the store that a probe uses is not reported
async function packageStoreRoot(cwd, signal) {
  let dir = null;
  try {
    const text = await readCapped(join(cwd, "node_modules", ".modules.yaml"), signal);
    dir = text === null ? null : recordedStoreDir(text);
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
  if (!dir || !isAbsolute(dir)) return null;
  const configured = envValue("pnpm_config_store_dir") ?? envValue("pnpm_config_store-dir");
  if (configured && storeRootOf(cwd, configured) !== storeRootOf(cwd, dir)) return null;
  return VERSION_DIR.test(basename(dir)) ? dirname(dir) : dir;
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
  try {
    // Each read of the directory is a file system call, so the bound is checked before each one.
    for (;;) {
      signal.throwIfAborted();
      const entry = await handle.read();
      if (entry === null) return names;
      if (names.length >= scanLimit) throw new Error(`more than ${scanLimit} entries in ${dir}`);
      names.push(entry.name);
    }
  } finally {
    // The close of an opened handle is the one call that can follow the bound.
    await handle.close();
  }
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
  return { root, entries: signatures };
}

/**
 * Reads the names of the pnpm store entries that an install changes, with a signature each, or
 * null, after a warning, when the store cannot be read in time and size. Null without a warning
 * when the root is unknown (see `packageStoreRoot`). The snapshot keeps its `root`, so two
 * snapshots of different stores are never compared. A missing store reads as empty. Reads names,
 * sizes, and times only, never store file content. The read has its own time bound and takes no
 * turn signal, so a canceled turn is read too and the read never changes the cancel outcome.
 * `boundMs` ends the read itself: no file system call starts after it.
 * @param {{ cwd?: string, scanLimit?: number, boundMs?: number }} [options]
 * @returns {Promise<{ root: string, entries: Map<string, string> } | null>}
 */
export async function snapshotPackageStore({
  cwd = process.cwd(),
  scanLimit = SCAN_LIMIT,
  boundMs = READ_BOUND_MS,
} = {}) {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(new Error(`read took over ${boundMs} ms`)), boundMs);
  timer.unref();
  const stop = bound.signal;
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
    logWarn(`package store not read: ${firstErrorLine(readableErrorText(err))}`);
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
 * Returns [] when either read failed, or when the two reads saw different store roots.
 * @param {{ root: string, entries: Map<string, string> } | null} before
 * @param {{ cwd?: string }} [options] as for `snapshotPackageStore`
 * @returns {Promise<string[]>}
 */
export async function changedInPackageStore(before, options) {
  if (before === null) return [];
  const after = await snapshotPackageStore(options);
  if (after === null || after.root !== before.root) return [];
  const names = new Set();
  for (const [name, signature] of after.entries) {
    if (before.entries.get(name) !== signature) names.add(name);
  }
  for (const name of before.entries.keys()) if (!after.entries.has(name)) names.add(name);
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
