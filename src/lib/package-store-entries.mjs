import { open, opendir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { entryCarrier, reportedEntryNames } from "./entry-report.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { withTimeBound } from "./time-bound.mjs";

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

/**
 * The `storeDir` that pnpm recorded in the `.modules.yaml` text, or null when the text is not
 * valid JSON or names none. pnpm 12.11.2 writes this file as JSON, so it is parsed strictly.
 */
function recordedStoreDir(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.storeDir === "string" ? parsed.storeDir : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the root of the store that `node_modules/.modules.yaml` of the work tree records, or
 * null when no store is recorded. The file is read up to a byte cap. The root is the parent of the
 * recorded `storeDir`, which pnpm writes as the version directory (`<root>/v11`). A missing,
 * unreadable, oversized, malformed, or store-less file, or a path that is not absolute, gives
 * null.
 *
 * The runtime does not predict which store a later install uses. The result only names the
 * recorded store, whatever selected it (config, the environment, or a flag).
 */
// known-limit: an install into a store other than the recorded one gives no field, whatever
// selected that store, and a work tree that never ran an install records none
async function packageStoreRoot(cwd, signal) {
  let dir = null;
  try {
    const text = await readCapped(join(cwd, "node_modules", ".modules.yaml"), signal);
    dir = text === null ? null : recordedStoreDir(text);
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
  return dir && isAbsolute(dir) ? dirname(dir) : null;
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
  try {
    return await withTimeBound(boundMs, `read took over ${boundMs} ms`, ({ signal, stopped }) => {
      const read = (async () => {
        const root = await packageStoreRoot(cwd, signal);
        if (root === null) {
          logDebug("package store root not known");
          return null;
        }
        return readStore(root, scanLimit, signal);
      })();
      read.catch(() => {});
      // A call in flight cannot be canceled, so the wait ends at the bound too.
      return Promise.race([read, stopped]);
    });
  } catch (err) {
    logWarn(`package store not read: ${firstErrorLine(readableErrorText(err))}`);
    return null;
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
  return reportedEntryNames(names);
}

const carrier = entryCarrier("packageStoreEntries");

/**
 * Carries the list on a fatal error as `err.packageStoreEntries`. A frozen error or a throwing
 * setter keeps the original error, and the list stays readable through `failedPackageStoreEntries`.
 */
export const carryPackageStoreEntries = carrier.carry;

/** Returns the list a fatal error carries, or `undefined` when it carries none. */
export const failedPackageStoreEntries = carrier.failed;
