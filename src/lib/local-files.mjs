// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0017). File bytes move only through one
// verified source descriptor and one verified, exclusively created target
// descriptor. The module never prints, logs, or returns file content: every
// report is a path name.
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
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

/** True when an existing ancestor directory of `rel` under `base` is a symlink. */
async function hasLinkedAncestor(base, rel) {
  const parts = rel.split("/").slice(0, -1);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstatOrNull(current);
    if (stat === null) {
      return false;
    }
    if (stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

/**
 * Reads the main work tree path from `git worktree list`, where it is the first
 * entry. Returns null for a bare repository, which has no main work tree.
 */
async function readMainWorkTree(root) {
  const { stdout } = await git(root, ["worktree", "list", "--porcelain"]);
  const blocks = stdout
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length > 0);
  const [first] = blocks;
  if (!first || first.includes("bare")) {
    return null;
  }
  const pathOf = (lines) => lines.find((line) => line.startsWith("worktree "))?.slice(9);
  return pathOf(first);
}

/**
 * Collects the candidate files of one listed path into `ctx.files` as
 * `{ rel, src }`. No symlink is followed: a symlink entry is skipped by name, and
 * so is a listed path under a symlinked directory, so every path that is read
 * lies inside the main work tree. `.git`, `.claude/worktrees`, and every
 * directory that holds a `.git` entry (a nested work tree or repository) are
 * dropped silently, because they hold repository state or a checkout, not a
 * local file.
 */
async function collect(ctx, rel, abs) {
  if (isExcludedRel(rel)) {
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
 * of the linked work tree, never follows a symlink, never copies a work tree
 * directory, `.git`, `.gitignore`, or `.gitattributes`, and never writes through
 * a symlinked directory of the linked work tree. Name exclusions compare folded
 * names, so case and Windows aliases do not bypass them. Returns `{ copied,
 * skipped }` as sorted root-relative path names, or null when `cwd` is the main
 * work tree or the repository is bare, where nothing is copied. An untracked
 * file that is not copied is in `skipped`. A listed directory that holds more
 * than `MAX_WALKED_ENTRIES` entries is in `skipped` as one name and none of its
 * files is copied.
 *
 * `hooks` is a test seam that runs just before the source and the target of one
 * file are opened.
 * @param {string} cwd
 * @param {{ beforeSourceOpen?: (rel: string) => Promise<void>, beforeTargetOpen?: (rel: string) => Promise<void> }} [hooks]
 * @returns {Promise<{ copied: string[], skipped: string[] } | null>}
 */
export async function copyLocalFiles(cwd, hooks = {}) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const main = await readMainWorkTree(root);
  if (!main || (await realpath(main)) === (await realpath(root))) {
    return null;
  }
  const mainReal = await realpath(main);
  const rootReal = await realpath(root);

  const skipped = new Set();
  const files = [];
  for (const rel of LOCAL_FILE_PATHS) {
    // One bound and one result list per listed path, so a path past its bound is
    // dropped whole and never starves the next listed path.
    const ctx = {
      files: [],
      skipped: new Set(),
      budget: { left: MAX_WALKED_ENTRIES, exceeded: false },
    };
    const abs = join(mainReal, rel);
    if ((await lstatOrNull(abs)) !== null && (await hasLinkedAncestor(mainReal, rel))) {
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
    if (
      GIT_CONTROL_FILES.has(foldName(basename(file.rel))) ||
      (await lstatOrNull(join(rootReal, file.rel))) !== null ||
      (await hasLinkedAncestor(rootReal, file.rel))
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
    if (ignored.has(rel) && (await copyOne(src, rootReal, rel, hooks))) {
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
 * Verifies that an open descriptor is the regular file that `path` names now,
 * through no symlink: the path resolves to itself, and its `lstat` identity is
 * the descriptor identity. A swap of the file or of any ancestor before or after
 * the open is therefore detected, and the descriptor, not the path, is read or
 * written afterwards.
 */
async function descriptorIsPath(handle, path) {
  const [opened, resolved, named] = await Promise.all([
    handle.stat({ bigint: true }),
    realpath(path),
    lstat(path, { bigint: true }),
  ]);
  return foldPath(resolved) === foldPath(path) && named.isFile() && sameFile(opened, named);
}

/** Removes `path` only when it still names the file that `handle` created. */
async function removeIfCreated(handle, path) {
  try {
    const created = await handle.stat({ bigint: true });
    const named = await lstatOrNull(path, { bigint: true });
    if (named && sameFile(created, named)) {
      await unlink(path);
    }
  } catch {
    // Nothing more can be removed safely.
  }
}

/** Creates each missing directory under `rootReal` one level at a time, none through a symlink. */
async function ensureDirectories(rootReal, rel) {
  let current = rootReal;
  for (const part of rel.split("/").slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
    }
    if (!(await lstat(current)).isDirectory()) {
      return false;
    }
  }
  return true;
}

/**
 * Copies one source file to `rootReal/rel` without overwrite. The source is
 * opened without following a final symlink and verified against its path, the
 * target is created exclusively and verified before any byte is written, and a
 * target that fails the check is removed when it is still the file just created.
 * Returns false when the file is not copied.
 */
async function copyOne(sourcePath, rootReal, rel, hooks) {
  const targetPath = join(rootReal, rel);
  let source = null;
  let target = null;
  try {
    await hooks.beforeSourceOpen?.(rel);
    source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await source.stat({ bigint: true });
    if (stat.size > BigInt(MAX_FILE_BYTES) || !(await descriptorIsPath(source, sourcePath))) {
      return false;
    }
    if (!(await ensureDirectories(rootReal, rel))) {
      return false;
    }
    await hooks.beforeTargetOpen?.(rel);
    // O_EXCL refuses an existing target and a symlink at the target.
    target = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      Number(stat.mode & 0o777n),
    );
    if (!(await descriptorIsPath(target, targetPath))) {
      await removeIfCreated(target, targetPath);
      return false;
    }
    // Bounded read: the file can have grown since the size check.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length <= MAX_FILE_BYTES) {
      const { bytesRead } = await source.read(buffer, length, MAX_FILE_BYTES + 1 - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) {
      await removeIfCreated(target, targetPath);
      return false;
    }
    await target.write(buffer, 0, length);
    return true;
  } catch (err) {
    if (target) {
      await removeIfCreated(target, targetPath);
    }
    // The code names the failure. The message can hold the path, never content.
    logWarn(`local files: a copy failed (${err.code ?? "error"})`);
    return false;
  } finally {
    await source?.close();
    await target?.close();
  }
}
