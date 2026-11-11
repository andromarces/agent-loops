// Hashes, compares, and refreshes copied local files (ADR 0074, ADR 0075, ADR 0078). Content is
// compared by SHA-256 and never returned, logged, or written to a report.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { mapInBatches } from "./batches.mjs";
import { isSha256Hex, sha256 } from "./hash.mjs";
import { isJsonObject } from "./json.mjs";
import {
  hasBlockedAncestor,
  MAX_FILE_BYTES,
  namesFile,
  READ_BATCH_SIZE,
  sameFile,
} from "./local-files.mjs";
import { locateWorkTrees, signalBoundReadWorkTree } from "./work-tree-layout.mjs";

const MISSING = Symbol("missing");
const NOT_COMPARABLE = Symbol("not comparable");

/** True for a non-empty relative path with no `..` segment and no empty segment. */
const isPlainRelativeName = (rel) =>
  typeof rel === "string" &&
  rel !== "" &&
  !isAbsolute(rel) &&
  !rel.split("/").some((part) => part === ".." || part === "");

/**
 * Reads the regular file `rel` under `base` and returns `{ bytes, hash, mode }`.
 * It returns `MISSING` when no file exists, or `NOT_COMPARABLE` when the path cannot be proven safe.
 * The caller never counts `NOT_COMPARABLE` as equal, even when both sides return it.
 * The checks follow the order marked in the body, and any error after the first probe is not comparable.
 * known-limit: a swap that is made and undone between two checks is not detected.
 * A swap that stays in place needs local write access and is caught before the read.
 */
async function readGuardedFile(base, rel, { beforeRead, afterAncestorCheck } = {}) {
  // Resolve and stat first, so only a proven absence is MISSING.
  const path = join(base, rel);
  let canon;
  let named;
  try {
    canon = await realpath(path);
    named = await lstat(path, { bigint: true });
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return MISSING;
    }
    throw err;
  }
  let handle = null;
  try {
    // Require the canonical path to equal the requested path and every ancestor to be plain.
    if (
      canon !== path ||
      !named.isFile() ||
      named.size > BigInt(MAX_FILE_BYTES) ||
      (await hasBlockedAncestor(base, rel, new Set()))
    ) {
      return NOT_COMPARABLE;
    }
    // The test seams run with the absolute path after the ancestor check and before the open.
    await afterAncestorCheck?.(path);
    if ((await realpath(path)) !== canon) {
      return NOT_COMPARABLE;
    }
    await beforeRead?.(path);
    // Open without a final link, then require the handle identity and path to match the first stat.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_FILE_BYTES) ||
      !sameFile(opened, named) ||
      !(await namesFile(path, canon, opened))
    ) {
      return NOT_COMPARABLE;
    }
    // Read from the handle only.
    const bytes = await handle.readFile();
    // Recheck the path and ancestors, so a swap during the read is not comparable.
    if (
      (await hasBlockedAncestor(base, rel, new Set())) ||
      !(await namesFile(path, canon, opened))
    ) {
      return NOT_COMPARABLE;
    }
    return { bytes, hash: sha256(bytes), mode: Number(named.mode & 0o777n) };
  } catch (err) {
    // A file that vanished, a link met by `O_NOFOLLOW`, or a path that cannot be opened after the
    // first probe is not comparable. It is never "missing", because an absence after the probe is
    // not proven.
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(err.code)) {
      return NOT_COMPARABLE;
    }
    throw err;
  } finally {
    await handle?.close();
  }
}

/** The SHA-256 from `readGuardedFile`, or its `MISSING` or `NOT_COMPARABLE` symbol. */
async function sha256Of(base, rel, hooks) {
  const read = await readGuardedFile(base, rel, hooks);
  return typeof read === "object" ? read.hash : read;
}

/**
 * Hashes each named file of the copy root, where `names` is the `copied` list of the init copy.
 * Returns a plain object of path to SHA-256 hex, or an empty object when there is no main work
 * tree. A name that cannot be hashed is left out, so the later compare fails closed for it.
 * Content is never returned or logged, and `afterAncestorCheck` and `beforeRead` are test seams.
 * `located` is a layout that the caller already read.
 * @param {string} cwd
 * @param {string[]} names
 * @param {{ signal?: AbortSignal, located?: object | null, afterAncestorCheck?: (path: string) => Promise<void>, beforeRead?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function hashCopiedLocalFiles(cwd, names, { signal, located, ...hooks } = {}) {
  return hashCopiedNames(cwd, names, { signal, ...hooks }, (found) => found.rootReal, {
    located,
  });
}

/**
 * Hashes each named source file in the main work tree of a linked `cwd`. The result shape and the
 * failure rules match `hashCopiedLocalFiles`. A turn window compares two results to name the
 * sources that a turn changed. `main` is a main-work-tree path that the caller already read.
 * @param {string} cwd
 * @param {string[]} names
 * @param {{ signal?: AbortSignal, main?: string | null, afterAncestorCheck?: (path: string) => Promise<void>, beforeRead?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function hashCopiedLocalSources(cwd, names, { signal, main, ...hooks } = {}) {
  return hashCopiedNames(cwd, names, { signal, ...hooks }, (found) => found.mainReal, { main });
}

async function hashCopiedNames(cwd, names, { signal, ...hooks }, baseOf, { located, main } = {}) {
  if (main === null || located === null) {
    return {};
  }
  let base;
  if (main !== undefined) {
    base = main;
  } else {
    let found = located;
    if (found === undefined) {
      found = await locateWorkTrees(cwd, signalBoundReadWorkTree(signal));
    }
    if (found === null) {
      return {};
    }
    base = baseOf(found);
  }
  const pairs = await mapInBatches(names, READ_BATCH_SIZE, async (rel) => {
    if (!isPlainRelativeName(rel)) {
      return null;
    }
    const hash = await sha256Of(base, rel, hooks);
    return typeof hash === "string" ? [rel, hash] : null;
  });
  return Object.fromEntries(pairs.filter(Boolean));
}

/**
 * Names the copied local files whose source or copy differs from the stored hash.
 * A parent uses the result to tell a stale copy from a turn edit.
 * `changed` is `source`, `copy`, `both`, or `unknown`, and the result is a list of `{path, changed}` entries.
 * `unknown` covers a legacy or malformed init hash, and a side with an absent stored hash reports `unknown`.
 * A missing or unreadable side counts as changed on that side.
 * Nothing is written, and content is never returned or logged.
 */
export async function findLocalFileChanges(cwd, names, initHashes, { signal, ...hooks } = {}) {
  // The result is sorted by path, or empty when there is no main work tree.
  const located = await locateWorkTrees(cwd, signalBoundReadWorkTree(signal));
  if (located === null) {
    return [];
  }
  const hashes = isJsonObject(initHashes) ? initHashes : null;
  // `afterAncestorCheck` and `beforeRead` are test seams on the guarded read.
  const pairs = await mapInBatches(names, READ_BATCH_SIZE, async (rel) => {
    if (!isPlainRelativeName(rel)) {
      return { rel, source: NOT_COMPARABLE, copy: NOT_COMPARABLE };
    }
    const [source, copy] = await Promise.all([
      sha256Of(located.mainReal, rel, hooks),
      sha256Of(located.rootReal, rel, hooks),
    ]);
    return { rel, source, copy };
  });
  return pairs
    .map(({ rel, source, copy }) => {
      const changed = changedSide(rel, source, copy, hashes);
      return changed === null ? null : { path: String(rel), changed };
    })
    .filter(Boolean)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The side that the stored hash proves changed, or `unknown` when it proves none. */
function changedSide(rel, source, copy, hashes) {
  if (hashes === null || !Object.hasOwn(hashes, rel)) {
    return "unknown";
  }
  const init = hashes[rel];
  if (typeof init !== "string" || !isSha256Hex(init)) {
    return "unknown";
  }
  const sourceChanged = source === MISSING || source === NOT_COMPARABLE || source !== init;
  const copyChanged = copy === MISSING || copy === NOT_COMPARABLE || copy !== init;
  if (sourceChanged && copyChanged) {
    return "both";
  }
  return sourceChanged ? "source" : copyChanged ? "copy" : null;
}

/**
 * Sets the mode of `target` when it is still the regular file at `rel` under `base` and no link
 * sits at the file or an ancestor. Returns false when that cannot be proven.
 * known-limit: a swap between the last check and `chmod` is not detected. The window is the one
 * path-based `chmod` shares with `rename`, so it is not wider than the rename window.
 */
async function chmodPlain(base, rel, target, mode) {
  let plain = false;
  try {
    const [resolved, named, blocked] = await Promise.all([
      realpath(target),
      lstat(target, { bigint: true }),
      hasBlockedAncestor(base, rel, new Set()),
    ]);
    plain = resolved === target && named.isFile() && !blocked;
  } catch (err) {
    if (!["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(err.code)) {
      throw err;
    }
  }
  if (!plain) {
    return false;
  }
  await chmod(target, mode);
  return true;
}

/**
 * Copies one source file over its run copy and returns the hash of the bytes written.
 * Reads the source once, then writes those bytes through a temporary file and a rename, or replaces
 * nothing when the copy already holds those bytes.
 * The temporary file starts at 0600, then takes the copy's prior mode on the open handle.
 * On Windows, a read-only target is cleared for the rename and takes the prior mode back from
 * the temporary file; a failed rename restores the target mode before the cleanup.
 * Refuses before any write when a side is missing or unreadable, a link sits on the path, or the
 * copy differs from `expectedCopyHash`. Content and hashes never reach a log line or an error text.
 * @param {string} cwd
 * @param {string} rel
 * @param {{ signal?: AbortSignal, expectedCopyHash?: string, beforeWrite?: (path: string) => Promise<void>, beforeTempCreate?: (path: string) => Promise<void>, beforeReadOnlyClear?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<string>} the new SHA-256 of the copy
 * @throws {Error} with a message that starts `refresh-local`
 */
export async function refreshLocalFile(
  cwd,
  rel,
  { signal, expectedCopyHash, beforeWrite, beforeTempCreate, beforeReadOnlyClear } = {},
) {
  const refuse = (why) => new Error(`refresh-local is refused: ${why}`);
  if (!isPlainRelativeName(rel)) {
    throw refuse("the path must stay inside the work tree");
  }
  const located = await locateWorkTrees(cwd, signalBoundReadWorkTree(signal));
  if (located === null) {
    throw refuse("there is no main work tree to refresh from");
  }
  const { mainReal, rootReal } = located;
  const source = await readGuardedFile(mainReal, rel);
  if (typeof source !== "object") {
    throw refuse("the source is missing or unreadable");
  }
  const copy = await readGuardedFile(rootReal, rel);
  if (typeof copy !== "object") {
    throw refuse("the copy is missing or unreadable");
  }
  if (expectedCopyHash !== undefined && copy.hash !== expectedCopyHash) {
    throw refuse("the copy changed after init, so a turn changed it");
  }
  const target = join(rootReal, rel);
  await beforeWrite?.(target);
  // An unchanged copy needs no replace, so its bytes, mode, and inode stay as they are.
  if (copy.hash === source.hash) {
    return copy.hash;
  }
  const temp = join(dirname(target), `.refresh-${randomUUID()}.tmp`);
  await beforeTempCreate?.(temp);
  // Remove the temporary path only after this call creates it.
  let created = false;
  let handle = null;
  let clearedReadOnly = false;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    await handle.writeFile(source.bytes);
    // Set the prior copy mode on the handle, so the umask cannot widen it.
    await handle.chmod(copy.mode);
    await handle.close();
    handle = null;
    // A Windows rename over a read-only target fails with EPERM. Clear the attribute before the
    // rename; the temporary file carries the prior copy mode, so the rename brings it back.
    // Re-check the path just before the clear. A swap after that check and before `chmod` can still
    // redirect it, in the same path-based window that the following rename has.
    if (process.platform === "win32") {
      await beforeReadOnlyClear?.(target);
      if (!(await chmodPlain(rootReal, rel, target, copy.mode | 0o200))) {
        throw Object.assign(new Error("a link sits on the path"), { code: "ELOOP" });
      }
      clearedReadOnly = true;
    }
    await rename(temp, target);
  } catch (err) {
    await handle?.close().catch(() => {});
    if (clearedReadOnly) {
      await chmodPlain(rootReal, rel, target, copy.mode).catch(() => {});
    }
    if (created) {
      await rm(temp, { force: true }).catch(() => {});
    }
    throw refuse(`the copy failed (${err.code ?? "error"})`);
  }
  return source.hash;
}
