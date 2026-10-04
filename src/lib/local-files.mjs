// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0017). Each file is copied with
// `copyFile` and `COPYFILE_EXCL`, so an existing file is never replaced or
// deleted. The module never prints, logs, or returns file content: every report
// is a path name.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
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
 * is copied. A file whose check fails is in `skipped`.
 *
 * Approved limit (ADR 0017): Node has no descriptor-relative open, so a directory
 * or link swapped between a check and the `copyFile` call can redirect that read
 * or write. A swap needs local write access to the work trees during init.
 *
 * `hooks` is a test seam. `beforeSourceOpen` and `beforeCopy` run with the file's
 * path name just before the source is opened and just before `copyFile`.
 * @param {string} cwd
 * @param {{ beforeSourceOpen?: (rel: string) => Promise<void>, beforeCopy?: (rel: string) => Promise<void> }} [hooks]
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

  const insensitive = await isCaseInsensitive(mainReal);

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
    if (
      ignored.has(rel) &&
      (await copyOne(src, rootReal, rel, targetBlocked, insensitive, hooks))
    ) {
      copied.push(rel);
    } else {
      skipped.add(rel);
    }
  }

  logInfo(`local files: ${copied.length} copied, ${skipped.size} skipped`);
  return { copied: copied.sort(), skipped: [...skipped].sort() };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * Whether the directory `dir` of a Git work tree is on a file system that reads
 * names without regard to case, probed with its `.git` entry. Unknown counts as
 * case-sensitive, the strict answer.
 */
async function isCaseInsensitive(dir) {
  const [lower, upper] = await Promise.all([
    lstatOrNull(join(dir, ".git"), { bigint: true }),
    lstatOrNull(join(dir, ".GIT"), { bigint: true }),
  ]);
  return lower !== null && upper !== null && sameFile(lower, upper);
}

/**
 * True when `path` resolves to itself, through no symlink, and names the regular
 * file with the identity of `opened` (a `bigint` `stat`). A path that resolves to
 * itself only up to case counts as itself on a case-insensitive file system only:
 * on a case-sensitive one it is another directory, which can lie outside the work
 * tree.
 */
async function namesFile(path, opened, insensitive) {
  const [resolved, named] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  const sameName = resolved === path || (insensitive && foldPath(resolved) === foldPath(path));
  return sameName && named.isFile() && sameFile(opened, named);
}

/**
 * Copies one source file to `rootReal/rel` and returns true when `copyFile` did.
 * Each check fails closed: the file is skipped.
 * 1. Open the source without following a final symlink, and check that the opened
 *    file is the regular file within the size cap that the path names.
 * 2. Create the missing target directories one level at a time, none through a
 *    symlink, none holding a `.git` entry, none a registered work tree.
 * 3. `copyFile` with `COPYFILE_EXCL`, which refuses an existing target and never
 *    deletes one.
 * The checks run before `copyFile`, which reads and writes by path. A swap in
 * between is the approved limit of `copyLocalFiles`.
 */
async function copyOne(sourcePath, rootReal, rel, blocked, insensitive, hooks) {
  let source = null;
  try {
    await hooks.beforeSourceOpen?.(rel);
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await source.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.size > BigInt(MAX_FILE_BYTES) ||
      !(await namesFile(sourcePath, stat, insensitive))
    ) {
      return false;
    }
    if (await hasBlockedAncestor(rootReal, rel, blocked, true)) {
      return false;
    }
    await hooks.beforeCopy?.(rel);
    await copyFile(sourcePath, join(rootReal, rel), constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    // An existing target is the normal no-overwrite outcome and needs no warning.
    // The code names a failure. The message can hold a path, never content.
    if (err.code !== "EEXIST") {
      logWarn(`local files: a copy failed (${err.code ?? "error"})`);
    }
    return false;
  } finally {
    await source?.close();
  }
}
