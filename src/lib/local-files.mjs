// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0017). The module reads and writes file
// bytes only through `copyFile`. It never prints, logs, or returns file content:
// every report is a path name.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
const CLAUDE_WORKTREES = ".claude/worktrees";

// A configuration file is small. A larger file is a cache, a log, or a session
// store, so it is skipped and named instead of duplicated into every run.
export const MAX_FILE_BYTES = 1024 * 1024;

// Bounds the walk of a listed directory. A directory past it is skipped by name
// as a whole, so a huge `.claude/` cannot stall the init or flood the report.
export const MAX_WALKED_ENTRIES = 2000;

async function git(cwd, args, options = {}) {
  const result = await execa("git", args, { cwd, reject: false, ...options });
  if (result.exitCode !== 0 && !options.allowExit?.includes(result.exitCode)) {
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result;
}

const same = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function lstatOrNull(path) {
  try {
    return await lstat(path);
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
 * Reads the main work tree path and the other work tree paths from
 * `git worktree list`. Returns null for a bare repository, which has no main
 * work tree.
 */
async function readWorkTrees(root) {
  const { stdout } = await git(root, ["worktree", "list", "--porcelain"]);
  const blocks = stdout
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length > 0);
  const [first, ...rest] = blocks;
  if (!first || first.includes("bare")) {
    return null;
  }
  const pathOf = (lines) => lines.find((line) => line.startsWith("worktree "))?.slice(9);
  return { main: pathOf(first), others: rest.map(pathOf).filter(Boolean) };
}

/**
 * Lists the candidate files of one listed path in the main work tree. A symlink,
 * a directory past the walk bound, and a path under a symlinked ancestor go to
 * `skipped`, so none is followed. A work tree directory is dropped silently,
 * because it holds a checkout, not a local file.
 */
async function collect(main, rel, others, found, budget) {
  const abs = join(main, rel);
  const stat = await lstatOrNull(abs);
  if (stat === null) {
    return;
  }
  if (stat.isSymbolicLink() || (await hasLinkedAncestor(main, rel))) {
    found.skipped.push(rel);
    return;
  }
  if (stat.isFile()) {
    found.files.push(rel);
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  if (rel === CLAUDE_WORKTREES || others.some((other) => same(resolve(other), resolve(abs)))) {
    return;
  }
  if ((await lstatOrNull(join(abs, ".git"))) !== null) {
    return;
  }
  const entries = await readdir(abs, { withFileTypes: true });
  budget.left -= entries.length;
  if (budget.left < 0) {
    found.skipped.push(rel);
    return;
  }
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      found.skipped.push(child);
    } else if (entry.isFile() || entry.isDirectory()) {
      await collect(main, child, others, found, budget);
    }
  }
}

/**
 * Copies each untracked local file of the main work tree that is ignored in
 * `cwd`'s work tree into it, once, at init. A file is copied only when all three
 * hold: it exists in the main work tree, it is untracked there, and `git
 * check-ignore` in the linked work tree names it ignored. Never overwrites a file
 * of the linked work tree, never follows a symlink, and never copies a work tree
 * directory. Returns `{ copied, skipped }` as sorted root-relative path names, or
 * null when `cwd` is the main work tree or the repository is bare, where nothing
 * is copied. An untracked file that is not copied is in `skipped`.
 *
 * known-limit: the source is checked with `lstat` and then copied by path, so a
 * concurrent writer in the main work tree can swap a file for a symlink between
 * the two. The main work tree is the caller's own, so that actor is out of the
 * threat model (ADR 0017).
 * @param {string} cwd
 * @returns {Promise<{ copied: string[], skipped: string[] } | null>}
 */
export async function copyLocalFiles(cwd) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const trees = await readWorkTrees(root);
  if (!trees || (await realpath(trees.main)) === (await realpath(root))) {
    return null;
  }
  const { main, others } = trees;

  const found = { files: [], skipped: [] };
  const budget = { left: MAX_WALKED_ENTRIES };
  for (const rel of LOCAL_FILE_PATHS) {
    await collect(main, rel, others, found, budget);
  }

  const tracked = new Set(
    (await git(main, ["--literal-pathspecs", "ls-files", "-z", "--", ...LOCAL_FILE_PATHS])).stdout
      .split("\0")
      .filter(Boolean),
  );
  const skipped = new Set(found.skipped);
  const pending = [];
  for (const rel of found.files) {
    if (tracked.has(rel)) {
      continue;
    }
    if ((await lstatOrNull(join(root, rel))) !== null || (await hasLinkedAncestor(root, rel))) {
      skipped.add(rel);
    } else {
      pending.push(rel);
    }
  }

  const ignored = new Set();
  if (pending.length > 0) {
    const result = await git(root, ["check-ignore", "-z", "--stdin"], {
      input: `${pending.join("\0")}\0`,
      allowExit: [1],
    });
    for (const rel of result.stdout.split("\0").filter(Boolean)) {
      ignored.add(rel);
    }
  }

  const copied = [];
  for (const rel of pending) {
    if (!ignored.has(rel) || !(await copyOne(main, root, rel))) {
      skipped.add(rel);
    } else {
      copied.push(rel);
    }
  }

  logInfo(`local files: ${copied.length} copied, ${skipped.size} skipped`);
  return { copied: copied.sort(), skipped: [...skipped].sort() };
}

/** Copies one file without overwrite. Returns false when it is not copied. */
async function copyOne(main, root, rel) {
  const source = join(main, rel);
  const target = join(root, rel);
  try {
    const stat = await lstat(source);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return false;
    }
    await mkdir(dirname(target), { recursive: true });
    // COPYFILE_EXCL refuses an existing target, so nothing is overwritten.
    await copyFile(source, target, constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    // The code names the failure. The message can hold the path, never content.
    logWarn(`local files: a copy failed (${err.code ?? "error"})`);
    return false;
  }
}
