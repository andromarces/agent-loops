// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0017). File bytes move from one verified
// source descriptor into a private temporary file, which is then hard-linked to
// the target, so a target never holds a partial file and an existing file is
// never replaced. The module never prints, logs, or returns file content: every
// report is a path name.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { logInfo, logWarn } from "./log.mjs";

// Paths that can configure a child CLI or a build. A directory is walked, and the
// three conditions apply to each file inside it.
export const LOCAL_FILE_PATHS = [
  ".agents",
  ".claude",
  ".codex",
  ".env",
  ".envrc",
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "opencode.jsonc",
  "opencode.json",
  ".github/copilot-instructions.md",
  ".vscode",
];

// Where Claude Code creates work trees. Other work tree paths come from
// `git worktree list` and from a nested `.git` entry.
const CLAUDE_WORKTREES = [".claude", "worktrees"];

// A configuration file is small. A larger file is a cache, a log, or a session
// store, so it is skipped and named instead of duplicated into every run.
export const MAX_FILE_BYTES = 1024 * 1024;

// Bounds the walk of one listed directory, counting every entry read under it,
// nested directories included. A listed directory that holds more than this is
// skipped by name as a whole, with none of its files copied, so a huge `.claude/`
// cannot stall the init or flood the report. Each listed path has its own bound.
export const MAX_WALKED_ENTRIES = 2000;

// Files that change how Git reads a work tree. Copying one can un-ignore a file
// that was copied or change its line endings, so the snapshot would list it and
// the run's reviewed state would shift (ADR 0017).
const GIT_CONTROL_FILES = new Set([".gitignore", ".gitattributes"]);

async function git(cwd, args, options = {}) {
  const result = await execa("git", args, { cwd, reject: false, ...options });
  if (result.exitCode !== 0 && !options.allowExit?.includes(result.exitCode)) {
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result;
}

/**
 * Folds a file name to the form that the strictest file system reads it as:
 * lower case, no stream suffix (`name:stream`), and no trailing dots or spaces.
 * Every exclusion compares folded names on every platform, so a case or Windows
 * alias such as `.GITIGNORE`, `.GitAttributes`, or `.gitignore.` cannot bypass it.
 */
const foldName = (name) =>
  name
    .toLowerCase()
    .replace(/:.*$/s, "")
    .replace(/[. ]+$/, "");

const foldPath = (path) => path.toLowerCase();

/** True for a path that holds repository state or a checkout, never a local file. */
function isExcludedRel(rel) {
  const parts = rel.split("/").map(foldName);
  return (
    parts.includes(".git") ||
    CLAUDE_WORKTREES.every((name, index) => parts[index] === foldName(name))
  );
}

async function lstatOrNull(path, options) {
  try {
    return await lstat(path, options);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

/**
 * Walks the ancestor directories of `rel` under `base`, never `base` itself, and
 * returns true when one of them must not be read or written through: a symlink, a
 * directory that holds a `.git` entry, or a registered work tree listed in
 * `blocked` (folded paths). With `create`, a missing ancestor is created, one
 * level at a time and without following anything; without it, the walk stops at
 * the first missing ancestor.
 */
async function hasBlockedAncestor(base, rel, blocked, create = false) {
  let current = base;
  for (const part of rel.split("/").slice(0, -1)) {
    current = join(current, part);
    if (create) {
      await mkdir(current).catch((err) => {
        if (err.code !== "EEXIST") {
          throw err;
        }
      });
    }
    const stat = await lstatOrNull(current);
    if (stat === null) {
      return false;
    }
    if (
      !stat.isDirectory() ||
      blocked.has(foldPath(current)) ||
      (await lstatOrNull(join(current, ".git"))) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Reads every registered work tree path from `git worktree list`, the main work
 * tree first. Returns null for a bare repository, which has no main work tree.
 * A path that Git still lists counts as a work tree even when its `.git` entry is
 * gone.
 */
async function readWorkTrees(root) {
  const { stdout } = await git(root, ["worktree", "list", "--porcelain"]);
  const blocks = stdout
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length > 0);
  if (blocks.length === 0 || blocks[0].includes("bare")) {
    return null;
  }
  const paths = blocks
    .map((lines) => lines.find((line) => line.startsWith("worktree "))?.slice(9))
    .filter(Boolean);
  return await Promise.all(paths.map((path) => realpath(path).catch(() => resolve(path))));
}

/**
 * Collects the candidate files of one listed path into `ctx.files` as
 * `{ rel, src }`. No symlink is followed: a symlink entry is skipped by name, and
 * so is a listed path under a symlinked directory, so every path that is read
 * lies inside the main work tree. `.git`, `.claude/worktrees`, every registered
 * work tree, and every directory that holds a `.git` entry (a file or a
 * directory) are dropped silently, because they hold repository state or a
 * checkout, not a local file.
 */
async function collect(ctx, rel, abs) {
  if (isExcludedRel(rel) || ctx.others.has(foldPath(abs))) {
    return;
  }
  const stat = await lstatOrNull(abs);
  if (stat === null) {
    return;
  }
  if (stat.isSymbolicLink()) {
    ctx.skipped.add(rel);
  } else if (stat.isFile()) {
    ctx.files.push({ rel, src: abs });
  } else if (stat.isDirectory() && (await lstatOrNull(join(abs, ".git"))) === null) {
    const entries = await readdir(abs);
    ctx.budget.left -= entries.length;
    if (ctx.budget.left < 0) {
      ctx.budget.exceeded = true;
      return;
    }
    for (const name of entries) {
      await collect(ctx, `${rel}/${name}`, join(abs, name));
    }
  }
}

/**
 * Thrown when a path changed under the copy in a way that the checks detect but
 * cannot undo safely. It fails the init closed: nothing is deleted at the target,
 * and the message names the file only.
 */
class CopyChangedError extends Error {
  constructor(rel) {
    super(`local files: the work tree changed during the copy of ${rel}; check the work tree`);
    this.name = "CopyChangedError";
  }
}

/**
 * Copies each untracked local file of the main work tree that is ignored in
 * `cwd`'s work tree into it, once, at init. A file is copied only when all three
 * hold: it exists in the main work tree, it is untracked there, and `git
 * check-ignore` in the linked work tree names it ignored. Never overwrites a file
 * of the linked work tree, never follows a symlink, never reads or writes inside
 * `.git`, a registered work tree, or a directory that holds a `.git` entry, never
 * copies a `.gitignore` or `.gitattributes`, and never writes through a symlinked
 * directory of the linked work tree. Name exclusions compare folded names, so
 * case and Windows aliases do not bypass them. Returns `{ copied, skipped }` as
 * sorted root-relative path names, or null when `cwd` is the main work tree or
 * the repository is bare, where nothing is copied. An untracked file that is not
 * copied is in `skipped`. A listed directory that holds more than
 * `MAX_WALKED_ENTRIES` entries is in `skipped` as one name and none of its files
 * is copied. A file is in `copied` only after its target is in place and
 * verified. Throws when a verification finds that a path changed during the copy.
 *
 * `hooks` is a test seam. `beforeSourceOpen`, `beforeTargetCreate`, and
 * `beforeLink` run with the file's path name just before the source is opened,
 * the temporary file is created, and the temporary file is linked to its target.
 * @param {string} cwd
 * @param {{ beforeSourceOpen?: (rel: string) => Promise<void>, beforeTargetCreate?: (rel: string) => Promise<void>, beforeLink?: (rel: string) => Promise<void> }} [hooks]
 * @returns {Promise<{ copied: string[], skipped: string[] } | null>}
 */
export async function copyLocalFiles(cwd, hooks = {}) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const trees = await readWorkTrees(root);
  const rootReal = await realpath(root);
  if (!trees || foldPath(trees[0]) === foldPath(rootReal)) {
    return null;
  }
  const mainReal = trees[0];
  // A registered work tree is never read from (inside the main work tree) and
  // never written into (inside the linked work tree), whether or not its `.git`
  // entry is still there.
  const sourceBlocked = new Set(trees.slice(1).map(foldPath));
  const targetBlocked = new Set(trees.map(foldPath));
  targetBlocked.delete(foldPath(rootReal));

  const skipped = new Set();
  const files = [];
  for (const rel of LOCAL_FILE_PATHS) {
    // One bound and one result list per listed path, so a path past its bound is
    // dropped whole and never starves the next listed path.
    const ctx = {
      others: sourceBlocked,
      files: [],
      skipped: new Set(),
      budget: { left: MAX_WALKED_ENTRIES, exceeded: false },
    };
    const abs = join(mainReal, rel);
    if (
      (await lstatOrNull(abs)) !== null &&
      (await hasBlockedAncestor(mainReal, rel, sourceBlocked))
    ) {
      skipped.add(rel);
      continue;
    }
    await collect(ctx, rel, abs);
    if (ctx.budget.exceeded) {
      skipped.add(rel);
    } else {
      files.push(...ctx.files);
      ctx.skipped.forEach((name) => skipped.add(name));
    }
  }

  const tracked = new Set(
    (await git(mainReal, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean),
  );
  const pending = [];
  for (const file of files) {
    if (tracked.has(file.rel)) {
      continue;
    }
    // The target checks come before `git check-ignore`, which refuses a path
    // beyond a symlink or inside a nested repository.
    if (
      GIT_CONTROL_FILES.has(foldName(basename(file.rel))) ||
      (await lstatOrNull(join(rootReal, file.rel))) !== null ||
      (await hasBlockedAncestor(rootReal, file.rel, targetBlocked))
    ) {
      skipped.add(file.rel);
    } else {
      pending.push(file);
    }
  }

  const ignored = new Set();
  if (pending.length > 0) {
    const result = await git(rootReal, ["check-ignore", "-z", "--stdin"], {
      input: `${pending.map((file) => file.rel).join("\0")}\0`,
      allowExit: [1],
    });
    for (const rel of result.stdout.split("\0").filter(Boolean)) {
      ignored.add(rel);
    }
  }

  const copied = [];
  for (const { rel, src } of pending) {
    if (ignored.has(rel) && (await copyOne(src, rootReal, rel, targetBlocked, hooks))) {
      copied.push(rel);
    } else {
      skipped.add(rel);
    }
  }

  logInfo(`local files: ${copied.length} copied, ${skipped.size} skipped`);
  return { copied: copied.sort(), skipped: [...skipped].sort() };
}

const TEMP_SUFFIX = ".agent-loop-copy";

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * True when `path` resolves to itself, through no symlink, and names the regular
 * file with the identity of `opened` (a `bigint` `stat`). A swap of the file or of
 * any ancestor is detected when it is in place at the time of the check.
 */
async function namesFile(path, opened) {
  const [resolved, named] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  return foldPath(resolved) === foldPath(path) && named.isFile() && sameFile(opened, named);
}

/** Reads a whole open file, at most `MAX_FILE_BYTES`. Returns null when it is longer. */
async function readBounded(handle) {
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length <= MAX_FILE_BYTES) {
    const { bytesRead } = await handle.read(buffer, length, MAX_FILE_BYTES + 1 - length, length);
    if (bytesRead === 0) {
      break;
    }
    length += bytesRead;
  }
  return length > MAX_FILE_BYTES ? null : buffer.subarray(0, length);
}

/**
 * Copies one source file to `rootReal/rel` and returns true only when the target
 * is in place and verified. Steps, each failing closed:
 * 1. Open the source without following a final symlink, and check that the opened
 *    file is the regular file the path names. Bytes are read from that descriptor.
 * 2. Create the missing directories one level at a time, none through a symlink.
 * 3. Create a private temporary file beside the target with an unguessable name,
 *    check that it lies where expected, and only then write the bytes.
 * 4. Hard-link the temporary file to the target. A link never replaces a file and
 *    never follows a symlink at the target, and the target never holds a partial
 *    file. Check that the target names the temporary file's identity.
 * 5. Remove the temporary name. Nothing is ever deleted at the target. A swap that
 *    the checks detect after the fact throws `CopyChangedError`.
 * Node has no descriptor-relative open, so a directory swapped between a check and
 * the following path-based step is detected, not prevented.
 */
async function copyOne(sourcePath, rootReal, rel, blocked, hooks) {
  const targetPath = join(rootReal, rel);
  let source = null;
  let temp = null;
  let tempPath = null;
  try {
    await hooks.beforeSourceOpen?.(rel);
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await source.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.size > BigInt(MAX_FILE_BYTES) ||
      !(await namesFile(sourcePath, stat))
    ) {
      return false;
    }
    const data = await readBounded(source);
    if (data === null) {
      return false;
    }
    if (await hasBlockedAncestor(rootReal, rel, blocked, true)) {
      return false;
    }
    await hooks.beforeTargetCreate?.(rel);
    tempPath = join(dirname(targetPath), `.${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`);
    temp = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      Number(stat.mode & 0o777n),
    );
    const created = await temp.stat({ bigint: true });
    if (!(await namesFile(tempPath, created))) {
      throw new CopyChangedError(rel);
    }
    await temp.writeFile(data);
    await temp.close();
    temp = null;
    await hooks.beforeLink?.(rel);
    await link(tempPath, targetPath);
    if (!(await namesFile(targetPath, created))) {
      throw new CopyChangedError(rel);
    }
    return true;
  } catch (err) {
    if (err instanceof CopyChangedError) {
      throw err;
    }
    // An existing target is the normal no-overwrite outcome and needs no warning.
    // The code names a failure. The message can hold a path, never content.
    if (err.code !== "EEXIST") {
      logWarn(`local files: a copy failed (${err.code ?? "error"})`);
    }
    return false;
  } finally {
    await source?.close();
    await temp?.close();
    // Only the unguessable temporary name is removed, never the target.
    if (tempPath) {
      await unlink(tempPath).catch(() => {});
    }
  }
}
