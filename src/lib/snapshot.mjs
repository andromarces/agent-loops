import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
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

export async function assertGitWorkTree(cwd) {
  const result = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    reject: false,
  });

  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// Returns null only for an absent or non-regular file; read errors other than ENOENT propagate.
export async function sha256File(path) {
  let s;
  try {
    s = await stat(path);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") {
      return null;
    }
    throw err;
  }
  if (!s.isFile()) {
    return null;
  }
  try {
    const content = await readFile(path);
    return sha256(content);
  } catch (err) {
    if (err.code === "ENOENT") {
      // Raced with deletion between stat and read; treat as absent.
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

export async function snapshot(cwd) {
  // git status/ls-files emit repository-root-relative paths, so run them at the root.
  const rootResult = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    reject: false,
  });
  if (rootResult.exitCode !== 0) {
    throw new SnapshotError(`--cwd must be inside a Git work tree: ${cwd}`);
  }
  const root = rootResult.stdout.trim();

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
      throw new SnapshotError(`failed to hash ${filePath}: ${err.message}`, { cause: err });
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
 * @template T
 * @param {string} cwd
 * @param {string} role
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMutationCheck(cwd, role, fn) {
  const before = await snapshot(cwd);
  logDebug(`snapshot before ${role} turn taken (${before.workTree.length} work tree entries)`);
  let actionError = null;
  let result;

  try {
    result = await fn();
  } catch (err) {
    actionError = err;
  }

  let after;
  try {
    after = await snapshot(cwd);
  } catch (snapErr) {
    // A failed post-turn snapshot wins over the agent error; the agent error rides as cause.
    if (actionError) {
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

  if (actionError) {
    throw actionError;
  }

  return result;
}
