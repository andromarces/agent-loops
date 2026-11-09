// Git and work-tree operations of one batch loop. Every call is a bounded Git process, and a
// work tree is created from `origin/<base>` on a deterministic branch.
import { lstat as lstatRaw, mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { parseWorkTreeList } from "../lib/git-read.mjs";
import { execBounded } from "../lib/exec.mjs";

const GIT_TIMEOUT_MS = 120_000;

/** Runs one Git command and returns its exit code and trimmed output. */
export async function git(args, cwd, { signal = null } = {}) {
  const result = await execBounded("git", args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  return {
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    timedOut: Boolean(result.timedOut),
  };
}

/** Runs one Git command and throws on any nonzero exit. */
export async function gitOrThrow(args, cwd, { signal = null } = {}) {
  const result = await git(args, cwd, { signal });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

/** The registered work trees of the repository at `repo`. */
export async function readRegisteredWorkTrees(repo) {
  return parseWorkTreeList(await gitOrThrow(["worktree", "list", "--porcelain", "-z"], repo));
}

/**
 * The device and inode identity of `path` as bigint values, or null when it is missing. `stat`
 * reports the directory a link names; a link at the root is caught by the canonical-path check.
 */
export async function pathIdentity(path) {
  try {
    const found = await stat(path, { bigint: true });
    return { dev: found.dev, ino: found.ino };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** True when two identities name the same device and inode, compared as bigint. */
export function identityEqual(current, recorded) {
  try {
    return (
      BigInt(current.dev) === BigInt(recorded.dev) && BigInt(current.ino) === BigInt(recorded.ino)
    );
  } catch {
    return false;
  }
}

/**
 * Creates the linked work tree of one loop from `origin/<base>` and records its identity.
 * @returns {Promise<{ path: string, canonicalPath: string, dev: string, ino: string, branch: string }>}
 */
export async function createLoopWorkTree({ repo, base, workTree, branch }) {
  await mkdir(dirname(workTree), { recursive: true });
  await gitOrThrow(
    ["worktree", "add", "--no-track", "-b", branch, workTree, `origin/${base}`],
    repo,
  );
  const identity = await pathIdentity(workTree);
  if (identity === null) throw new Error("The new work tree is missing after git worktree add.");
  return {
    path: resolve(workTree),
    canonicalPath: await canonicalPath(workTree),
    dev: String(identity.dev),
    ino: String(identity.ino),
    branch,
  };
}

function prBranchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Reads whether the frozen pull request head can run on a named local branch without a reset. The
 * fetched `refs/pull/<n>/head` commit must equal the frozen head. A missing local branch is created
 * later; an existing branch at the head or behind it is used, with a fast-forward in the second
 * case. A branch with commits the frozen head lacks, or one checked out in another work tree, is
 * refused before any claim or work-tree write.
 * @returns {Promise<{ fetched: string, localHead: string | null, fastForward: boolean }>}
 */
export async function planPrWorkTree({ repo, branch, head, number }) {
  await gitOrThrow(["fetch", "origin", `refs/pull/${number}/head`], repo);
  const fetched = await gitOrThrow(["rev-parse", "FETCH_HEAD"], repo);
  if (typeof head !== "string" || head.trim() === "" || fetched !== head) {
    const error = prBranchError(
      "pr-head-moved",
      `pull request ${number} head moved: the frozen head is ${head ?? "unset"}, the fetched head is ${fetched}`,
    );
    error.frozen = head ?? null;
    error.current = fetched;
    throw error;
  }
  const target = `refs/heads/${branch}`;
  const entries = await readRegisteredWorkTrees(repo);
  if (entries.some((entry) => entry.branch === target)) {
    throw prBranchError(
      "pr-branch-checked-out",
      `branch ${branch} is checked out in another work tree`,
    );
  }
  const local = await git(["rev-parse", "--verify", "--quiet", target], repo);
  if (local.exitCode !== 0) return { fetched, localHead: null, fastForward: false };
  if (local.stdout === fetched) return { fetched, localHead: local.stdout, fastForward: false };
  const ancestor = await git(["merge-base", "--is-ancestor", local.stdout, fetched], repo);
  if (ancestor.exitCode !== 0) {
    throw prBranchError(
      "pr-branch-diverged",
      `branch ${branch} has commits the frozen head lacks: local ${local.stdout}, frozen ${fetched}`,
    );
  }
  return { fetched, localHead: local.stdout, fastForward: true };
}

/**
 * Creates the linked work tree of one pull request item on its named head branch at the frozen
 * head. No branch is forced or reset: a missing branch is created at the fetched head, a branch at
 * the head is used, and a branch behind it is fast-forwarded. A fetched commit that differs from
 * the frozen head is refused before checkout.
 * @returns {Promise<{ path: string, canonicalPath: string, dev: string, ino: string, branch: string, head: string }>}
 */
export async function createPrWorkTree({ repo, workTree, branch, head, number }) {
  const plan = await planPrWorkTree({ repo, branch, head, number });
  await mkdir(dirname(workTree), { recursive: true });
  if (plan.localHead === null) {
    await gitOrThrow(["worktree", "add", "--no-track", "-b", branch, workTree, plan.fetched], repo);
  } else {
    await gitOrThrow(["worktree", "add", workTree, branch], repo);
    if (plan.fastForward) {
      await gitOrThrow(["merge", "--ff-only", plan.fetched], workTree);
    }
  }
  const identity = await pathIdentity(workTree);
  if (identity === null) throw new Error("The new work tree is missing after git worktree add.");
  return {
    path: resolve(workTree),
    canonicalPath: await canonicalPath(workTree),
    dev: String(identity.dev),
    ino: String(identity.ino),
    branch,
    head: plan.fetched,
  };
}

/** The checked-out branch, head commit, and porcelain status of a work tree. */
export async function readWorkTreeState(workTree) {
  const branch = await gitOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], workTree);
  const head = await gitOrThrow(["rev-parse", "HEAD"], workTree);
  const status = await gitOrThrow(["status", "--porcelain"], workTree);
  return { branch, head, clean: status === "" };
}

/** Fetches one branch from `origin` and returns its remote head, or null when it does not exist. */
export async function fetchRemoteBranch(repo, branch) {
  const fetched = await git(["fetch", "origin", branch], repo);
  if (fetched.exitCode !== 0) return null;
  const head = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    repo,
  );
  return head.exitCode === 0 ? head.stdout : null;
}

/** Reads the remote head of `branch` without a fetch. */
export async function readRemoteBranch(repo, branch) {
  const head = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    repo,
  );
  return head.exitCode === 0 ? head.stdout : null;
}

/** True when `ancestor` is reachable from `descendant`. */
export async function isAncestor(ancestor, descendant, cwd) {
  if (!ancestor || !descendant) return false;
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  return result.exitCode === 0;
}

/** The number of commits that `to` holds and `from` lacks. */
export async function commitsAhead(from, to, cwd) {
  const result = await git(["rev-list", "--count", `${from}..${to}`], cwd);
  return result.exitCode === 0 ? Number(result.stdout) : null;
}

export const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Removes a linked work tree with `git worktree remove --force`. A directory that Git leaves
 * behind is removed only when it holds no real file and still has `identity`.
 * @returns {Promise<{ removed: boolean, reason: string | null }>}
 */
export async function removeWorkTree(repo, workTree, identity) {
  const result = await git(["worktree", "remove", "--force", workTree], repo);
  if ((await pathIdentity(workTree)) === null) {
    return { removed: true, reason: null };
  }
  if (result.exitCode !== 0) {
    return { removed: false, reason: `git worktree remove failed: ${result.stderr}` };
  }
  return removeDirectoryWithoutLinks(workTree, identity);
}

/**
 * Deletes `path` only while it holds directories and links, never a real file, and only while its
 * device and inode still match. A link is unlinked, never followed.
 * @returns {Promise<{ removed: boolean, reason: string | null }>}
 */
export async function removeDirectoryWithoutLinks(path, identity) {
  // Inspect the whole remainder first, so a refusal leaves every entry in place.
  const check = await inspectRemainder(path, identity, true);
  if (!check.ok) return { removed: false, reason: check.reason };
  return deleteRemainder(path, identity, true);
}

// Checks the root identity, then every entry below it. A link is allowed, a real file is not.
async function inspectRemainder(path, identity, root) {
  if (root) {
    const current = await pathIdentity(path);
    if (current === null) return { ok: true };
    if (!identityEqual(current, identity)) {
      return { ok: false, reason: "the directory identity changed" };
    }
  }
  const found = await lstatRaw(path);
  if (found.isSymbolicLink()) return { ok: true };
  if (!found.isDirectory()) return { ok: false, reason: "a real file remains" };
  for (const entry of await readdir(path)) {
    const child = resolve(path, entry);
    const childFound = await lstatRaw(child);
    if (childFound.isSymbolicLink()) continue;
    if (childFound.isDirectory()) {
      const result = await inspectRemainder(child, null, false);
      if (!result.ok) return result;
      continue;
    }
    return { ok: false, reason: "a real file remains" };
  }
  return { ok: true };
}

// The second pass deletes only what the first pass inspected. It repeats the identity check on the
// root, so a path replaced between the checks is kept.
async function deleteRemainder(path, identity, root) {
  if (root) {
    const current = await pathIdentity(path);
    if (current === null) return { removed: true, reason: null };
    if (!identityEqual(current, identity)) {
      return { removed: false, reason: "the directory identity changed" };
    }
  }
  const found = await lstatRaw(path);
  if (found.isSymbolicLink()) {
    await unlink(path);
    return { removed: true, reason: null };
  }
  if (!found.isDirectory()) return { removed: false, reason: "a real file remains" };
  for (const entry of await readdir(path)) {
    const child = resolve(path, entry);
    const childFound = await lstatRaw(child);
    if (childFound.isSymbolicLink()) {
      await unlink(child);
      continue;
    }
    if (childFound.isDirectory()) {
      const result = await deleteRemainder(child, null, false);
      if (!result.removed) return result;
      continue;
    }
    return { removed: false, reason: "a real file remains" };
  }
  try {
    await rmdir(path);
  } catch (err) {
    return { removed: false, reason: err?.message ?? "the directory could not be removed" };
  }
  return { removed: true, reason: null };
}
