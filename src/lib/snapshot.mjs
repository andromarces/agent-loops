import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { killTreeOnExit } from "./exec-tree.mjs";
import { readableErrorText } from "./error-message.mjs";
import { sha256 } from "./hash.mjs";
import { logDebug, logError } from "./log.mjs";

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
  }
}

/**
 * Refuses unless `cwd` is inside a Git work tree. `timeoutMs` bounds the probe
 * and terminates the `git` child on expiry, so a caller that owns a total
 * limit keeps that limit even when the probe hangs. A probe cut short by the
 * bound refuses, because a work tree it never confirmed is not a verified one.
 */
export async function assertGitWorkTree(cwd, { timeoutMs = 0 } = {}) {
  const options = { cwd, reject: false, cleanup: true, killDescendants: true };
  if (timeoutMs > 0) {
    options.timeout = timeoutMs;
    options.forceKillAfterDelay = 1000;
  }
  const result = await killTreeOnExit(
    execa("git", ["rev-parse", "--is-inside-work-tree"], options),
  );

  if (result.timedOut) {
    throw new SnapshotError(
      `--cwd validation did not complete within its bound, so the work tree was not confirmed: ${cwd}`,
    );
  }
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
}

// Returns null only for an absent or non-regular, non-symlink entry; read errors
// other than ENOENT propagate. A symlink hashes its link target text, not the
// file it points to, so two links with different targets never share a hash and
// a dangling or directory link still has a content identity. The link text is
// tagged before hashing, so a link never collides with a regular file that
// holds the same bytes.
export async function sha256File(path) {
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
    const content = await readFile(path);
    return sha256(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      // Raced with deletion between lstat and read; treat as absent.
      return null;
    }
    throw err;
  }
}

async function gitIn(cwd, args) {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new SnapshotError(
      `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result;
}

/** The Git work tree root that `snapshot` covers for `cwd`. */
export async function workTreeRoot(cwd) {
  const rootResult = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    reject: false,
  });
  if (rootResult.exitCode !== 0) {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
  return rootResult.stdout.trim();
}

export async function snapshot(cwd) {
  // git status/ls-files emit repository-root-relative paths, so run them at the root.
  const root = await workTreeRoot(cwd);

  // 1. Work tree status
  const statusResult = await gitIn(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);

  const statusTokens = statusResult.stdout.split("\0");
  const entries = [];

  for (let i = 0; i < statusTokens.length; i++) {
    const token = statusTokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);

    // If rename/copy (status 'R' or 'C'), -z outputs <new-path>\0<old-path>\0.
    // filePath is already <new-path>; consume <old-path> in nextToken so it is not processed as a file.
    if (status.includes("R") || status.includes("C")) {
      i++;
    }

    const fullPath = join(root, filePath);
    let hash;
    try {
      hash = await sha256File(fullPath);
    } catch (err) {
      throw new SnapshotError(`failed to hash ${filePath}: ${readableErrorText(err)}`, {
        cause: err,
      });
    }
    entries.push({ path: filePath, status, hash });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  // 2. Index hash (whole repository, not just cwd)
  const lsResult = await gitIn(root, ["ls-files", "--stage", "-z"]);
  const indexHash = sha256(lsResult.stdout);

  // 3. HEAD; exit 1 here means a repository without commits, so "unborn" is correct.
  const headResult = await execa("git", ["rev-parse", "--verify", "-q", "HEAD"], {
    cwd: root,
    reject: false,
  });
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn";

  return {
    workTree: entries,
    indexHash,
    head,
  };
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
 * without taking a second snapshot.
 * @template T
 * @param {string} cwd
 * @param {string} role
 * @param {(before: Awaited<ReturnType<typeof snapshot>>) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMutationCheck(cwd, role, fn) {
  const before = await snapshot(cwd);
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
  try {
    after = await snapshot(cwd);
  } catch (snapErr) {
    // A failed post-turn snapshot wins over the agent error; the agent error rides as cause.
    if (threw) {
      throw new SnapshotError(`post-turn snapshot failed during ${role} turn: ${snapErr.message}`, {
        cause: actionError,
      });
    }
    throw snapErr;
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
