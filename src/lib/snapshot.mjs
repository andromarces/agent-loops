import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import { mapInBatches } from "./batches.mjs";
import { execBounded } from "./exec.mjs";
import { readableErrorText } from "./error-message.mjs";
import { sha256 } from "./hash.mjs";
import { logDebug, logError } from "./log.mjs";
import { beginEvidenceRead, forceCancelSignal } from "./sigint.mjs";

// Milliseconds that one snapshot `git` read waits before it ends the child.
const GIT_READ_TIMEOUT_MS = 120_000;

export class MutationError extends Error {
  constructor(role, paths) {
    super(`Mutation detected during ${role} turn: ${paths.join(", ")}`);
    this.name = "MutationError";
    this.role = role;
    this.paths = paths;
  }
}

// Snapshot failure: a turn's mutation state could not be determined, so no verdict exists.
// Precedence note: if the agent turn was canceled (SIGINT) and the post-turn snapshot also fails,
// SnapshotError wins and the cancellation is not preserved; the caller exits 1, not 130.
export class SnapshotError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotError";
    // True when a cancel ended the read, so a caller keeps exit 130.
    this.isCanceled = options?.isCanceled === true;
  }
}

/**
 * Refuses unless `cwd` is inside a Git work tree. `timeoutMs` (default 120 s) bounds the probe
 * and terminates the `git` child on expiry, so a caller that owns a total
 * limit keeps that limit even when the probe hangs. A probe cut short by the
 * bound refuses, because a work tree it never confirmed is not a verified one.
 * `signal` ends the probe too, and the refusal then has `isCanceled` set.
 */
export async function assertGitWorkTree(cwd, { timeoutMs = GIT_READ_TIMEOUT_MS, signal } = {}) {
  const createError = (reason) =>
    new SnapshotError(
      reason === "canceled"
        ? `--cwd validation was canceled: ${cwd}`
        : `--cwd validation did not complete within its bound, so the work tree was not confirmed: ${cwd}`,
      { isCanceled: reason === "canceled" },
    );
  const result = await gitRead(cwd, ["rev-parse", "--is-inside-work-tree"], {
    timeoutMs,
    signal,
    createError,
  });

  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
}

// The error that Node's `fs` reads reject with after a cancel, which carries the reason as cause.
function abortError(signal) {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

// Returns null only for an absent or non-regular, non-symlink entry; read errors
// other than ENOENT propagate. A symlink hashes its link target text, not the
// file it points to, so two links with different targets never share a hash and
// a dangling or directory link still has a content identity. The link text is
// tagged before hashing, so a link never collides with a regular file that
// holds the same bytes. The file streams through the hash in chunks, so it is never held whole in
// memory, and only the bytes up to the size at open count. An aborted `signal` rejects with its
// reason before the `lstat`. A cancel after the `lstat` rejects with Node's AbortError (code
// ABORT_ERR, the reason as cause), and it wins over a later read error, including a file that
// vanished after the cancel. An abort during the read destroys the stream, which closes the file
// handle and rejects the read. An `fs` request already in flight is not interrupted, so the
// destroy takes effect after that request returns. The `lstat` and `readlink` calls take no
// signal.
export async function sha256File(path, { signal } = {}) {
  signal?.throwIfAborted();
  let s;
  try {
    s = await lstat(path);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  if (s.isSymbolicLink()) {
    return sha256(`symlink\0${await readlink(path)}`);
  }
  if (!s.isFile()) {
    return null;
  }
  try {
    if (signal?.aborted) {
      throw abortError(signal);
    }
    const hash = createHash("sha256");
    const handle = await open(path, "r");
    let stream;
    try {
      // Bound the read to the size of the opened file, as the whole-file read did, so a file that
      // grows during the read keeps the digest of its bytes at open. An empty file has no bound,
      // as an unbounded stream reads to EOF. The stream owns the handle and closes it on end,
      // error, or abort.
      const { size } = await handle.stat();
      const range = size > 0 ? { start: 0, end: size - 1 } : {};
      stream = createReadStream(path, { fd: handle, signal, ...range });
    } catch (err) {
      await handle.close();
      throw err;
    }
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  } catch (err) {
    // A cancel wins over a read error that follows it.
    if (signal?.aborted && err.code !== "ABORT_ERR") {
      throw abortError(signal);
    }
    if (err.code === "ENOENT") {
      // Raced with deletion between lstat and read; treat as absent.
      return null;
    }
    if (err.syscall && err.path === undefined) {
      // A stream read error omits the path that the whole-file read error named.
      err.path = path;
      err.message += ` '${path}'`;
    }
    throw err;
  }
}

function snapshotReadError(reason, { args, timeoutMs, result }) {
  if (reason === "canceled") {
    return new SnapshotError(`git ${args[0]} was canceled`, { isCanceled: true });
  }
  if (reason === "timeout") {
    return new SnapshotError(`git ${args[0]} timed out after ${timeoutMs} ms`);
  }
  return new SnapshotError(
    `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/**
 * Runs one bounded `git` read. A timeout or a cancel throws, because the read has no answer to
 * return. Any other exit code is data for the caller, unless `allowExit` lists the accepted exit
 * codes: then any other code throws too. `createError(reason, { args, timeoutMs, result })` builds
 * the error for `reason` `"canceled"` (it must set `isCanceled`), `"timeout"`, or `"exit"`; the
 * default builds a `SnapshotError`. Other options go to `execBounded`.
 */
export async function gitRead(
  cwd,
  args,
  {
    signal,
    timeoutMs = GIT_READ_TIMEOUT_MS,
    allowExit,
    createError = snapshotReadError,
    ...execOptions
  } = {},
) {
  const result = await execBounded("git", args, { cwd, timeoutMs, signal, ...execOptions });
  const context = { args, timeoutMs, result };
  if (result.isCanceled) {
    throw createError("canceled", context);
  }
  if (result.timedOut) {
    throw createError("timeout", context);
  }
  if (allowExit !== undefined && !allowExit.includes(result.exitCode)) {
    throw createError("exit", context);
  }
  return result;
}

const gitIn = (cwd, args, bound) => gitRead(cwd, args, { ...bound, allowExit: [0] });

/** The Git work tree root that `snapshot` covers for `cwd`. `bound` takes `signal` and `timeoutMs`. */
export async function workTreeRoot(cwd, bound) {
  const rootResult = await gitRead(cwd, ["rev-parse", "--show-toplevel"], bound);
  if (rootResult.exitCode !== 0) {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
  return rootResult.stdout.trim();
}

/**
 * Returns a resolver of the work tree root of `cwd` that asks `git` on its first call and returns that
 * root on every later call. The root is not checked again, so a caller must use one resolver only for
 * reads that no snapshot boundary separates: a `cwd` that is removed, or an ancestor of it that is
 * replaced by a link, between the first read and a later one is not seen. Reads after a turn take a
 * new resolver, so each snapshot of a mutation check and each post-turn read still sees the work tree
 * that `cwd` resolves to then. Only a root that was read is kept, so a failed or canceled read is
 * tried again. Calls that overlap each read their own.
 * @returns {(bound?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<string>}
 */
export function cachedWorkTreeRoot(cwd) {
  let root = null;
  return async (bound) => (root ??= await workTreeRoot(cwd, bound));
}

// Files that one snapshot hashes at a time, so a large work tree never opens every file at once.
const HASH_BATCH_SIZE = 32;

/**
 * Parses the `status --porcelain=v1 -z` output into entries without a hash. A rename or copy also
 * emits its old path, which is consumed and not listed.
 */
function statusEntries(stdout) {
  const tokens = stdout.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    // If rename/copy (status 'R' or 'C'), -z outputs <new-path>\0<old-path>\0.
    // The path is already <new-path>; consume <old-path> so it is not processed as a file.
    if (status.includes("R") || status.includes("C")) {
      i++;
    }
    entries.push({ path: token.slice(3), status });
  }
  return entries;
}

/**
 * Hashes the files of `entries` in batches of `HASH_BATCH_SIZE`. Entries keep their order, and the
 * first failure in that order throws, as the sequential hashes did.
 */
const hashEntries = (root, entries) =>
  mapInBatches(entries, HASH_BATCH_SIZE, async (entry) => {
    try {
      return { ...entry, hash: await sha256File(join(root, entry.path)) };
    } catch (err) {
      throw new SnapshotError(`failed to hash ${entry.path}: ${readableErrorText(err)}`, {
        cause: err,
      });
    }
  });

/**
 * Reads the Git-visible state of the work tree. Every `git` read has a time bound, `timeoutMs`
 * (default 120 s), and ends on `signal`. A timeout or a cancel throws a `SnapshotError`, and a cancel
 * sets its `isCanceled`. The status, index, and HEAD reads run together with the file hashes. The
 * first failure in the order status, hashes, index, HEAD throws, and the other reads end first.
 * `bound.rootOf(bound)` replaces the root read, so a caller that holds one root shares it.
 */
export async function snapshot(cwd, { rootOf, ...bound } = {}) {
  // git status/ls-files emit repository-root-relative paths, so run them at the root.
  const root = await (rootOf ?? ((b) => workTreeRoot(cwd, b)))(bound);

  const group = new AbortController();
  const signal = bound?.signal ? AbortSignal.any([bound.signal, group.signal]) : group.signal;
  const scoped = { ...bound, signal };
  const status = gitIn(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], scoped);
  // Index hash (whole repository, not just cwd).
  const index = gitIn(root, ["ls-files", "--stage", "-z"], scoped);
  // HEAD; exit 1 here means a repository without commits, so "unborn" is correct.
  const headRead = gitRead(root, ["rev-parse", "--verify", "-q", "HEAD"], scoped);
  const hashes = status.then((result) => hashEntries(root, statusEntries(result.stdout)));
  const reads = [status, hashes, index, headRead];
  for (const read of reads) {
    read.catch(() => {});
  }
  try {
    await status;
    const entries = await hashes;
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const indexHash = sha256((await index).stdout);
    const headResult = await headRead;
    return {
      workTree: entries,
      indexHash,
      head: headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn",
    };
  } catch (err) {
    group.abort();
    await Promise.allSettled(reads);
    throw err;
  }
}

/**
 * Derives the runtime-owned identity of the state a snapshot represents.
 * `digest` covers the work-tree entries (path, status, hash) and the index hash,
 * so two different uncommitted states at the same `head` differ. It identifies
 * the full Git-visible uncommitted state only when `exact` is true: a work-tree
 * entry with no content hash that is not a deletion (for example a submodule)
 * has no content identity. Ignored files are out of scope, because the snapshot
 * never lists them.
 * @param {Awaited<ReturnType<typeof snapshot>>} snap
 * @returns {{ head: string, clean: boolean, exact: boolean, digest: string }}
 */
export function reviewedState(snap) {
  const clean = snap.workTree.length === 0;
  const exact = snap.workTree.every((e) => e.hash !== null || e.status.includes("D"));
  const entries = snap.workTree.map((e) => [e.path, e.status, e.hash]);
  return {
    head: snap.head,
    clean,
    exact,
    digest: sha256(JSON.stringify({ entries, indexHash: snap.indexHash })),
  };
}

/**
 * Diff two snapshots. Returns the sorted changed work-tree paths, plus the
 * sentinel entries `<index>` and `<HEAD>` when the index or HEAD changed.
 * @param {Awaited<ReturnType<typeof snapshot>>} before
 * @param {Awaited<ReturnType<typeof snapshot>>} after
 * @returns {string[]}
 */
export function diffSnapshots(before, after) {
  const changed = new Set();

  const beforeMap = new Map(before.workTree.map((e) => [e.path, e]));
  const afterMap = new Map(after.workTree.map((e) => [e.path, e]));

  for (const [path, b] of beforeMap.entries()) {
    const a = afterMap.get(path);
    if (!a) {
      // It was dirty and now it's not (e.g. reverted or staged/committed)
      changed.add(path);
    } else if (b.status !== a.status || b.hash !== a.hash) {
      changed.add(path);
    }
  }

  for (const [path] of afterMap.entries()) {
    if (!beforeMap.has(path)) {
      changed.add(path);
    }
  }

  const result = Array.from(changed).sort();

  if (before.indexHash !== after.indexHash) {
    result.push("<index>");
  }

  if (before.head !== after.head) {
    result.push("<HEAD>");
  }

  return result;
}

/**
 * Run `fn()` and compare Git snapshots taken before and after.
 * Throws `MutationError` when the diff is non-empty, even when `fn()` already
 * failed: the mutation error wins over the wrapped error, which is discarded.
 * Any thrown value is rethrown unchanged, a falsy one (`null`, `undefined`) included.
 * `fn` receives the before snapshot, so a caller can derive the reviewed state
 * without taking a second snapshot. `signal` cancels the before snapshot only. The after snapshot
 * ignores it, so a canceled turn still reports the paths it changed. The after snapshot ends on
 * `forceSignal` instead (default: the second-SIGINT signal of `signal`). It then throws a canceled
 * `SnapshotError` that says the evidence was not captured, and never reports the tree as unchanged.
 * `rootOf` serves the before snapshot only. The after snapshot always reads the root again, so a
 * `cwd` that left its work tree during the turn is refused.
 * @template T
 * @param {string} cwd
 * @param {string} role
 * @param {(before: Awaited<ReturnType<typeof snapshot>>) => Promise<T>} fn
 * @param {{ signal?: AbortSignal, forceSignal?: AbortSignal, rootOf?: (bound: object) => Promise<string> }} [options]
 * @returns {Promise<T>}
 */
export async function withMutationCheck(
  cwd,
  role,
  fn,
  { signal, forceSignal = forceCancelSignal(signal), rootOf } = {},
) {
  const before = await snapshot(cwd, { signal, rootOf });
  logDebug(`snapshot before ${role} turn taken (${before.workTree.length} work tree entries)`);
  let threw = false;
  let actionError;
  let result;

  try {
    result = await fn(before);
  } catch (err) {
    threw = true;
    actionError = err;
  }

  let after;
  const endEvidenceRead = beginEvidenceRead(forceSignal);
  try {
    after = await snapshot(cwd, { signal: forceSignal });
  } catch (snapErr) {
    if (snapErr?.isCanceled) {
      throw new SnapshotError(
        `${role} turn changed-path evidence not captured: the snapshot was canceled`,
        { cause: threw ? actionError : snapErr, isCanceled: true },
      );
    }
    // A failed post-turn snapshot wins over the agent error; the agent error rides as cause.
    if (threw) {
      throw new SnapshotError(`post-turn snapshot failed during ${role} turn: ${snapErr.message}`, {
        cause: actionError,
      });
    }
    throw snapErr;
  } finally {
    endEvidenceRead();
  }
  logDebug(`snapshot after ${role} turn taken (${after.workTree.length} work tree entries)`);

  const diff = diffSnapshots(before, after);
  if (diff.length > 0) {
    const mutationError = new MutationError(role, diff);
    logError(mutationError.message);
    throw mutationError;
  }

  if (threw) {
    throw actionError;
  }

  return result;
}
