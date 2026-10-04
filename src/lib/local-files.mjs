// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0017). The module reads and writes file
// bytes only through `copyFile`. It never prints, logs, or returns file content:
// every report is a path name.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** True for a path that holds repository state or a checkout, never a local file. */
const isExcluded = (ctx, real) =>
  [join(ctx.main, ".git"), join(ctx.main, CLAUDE_WORKTREES), ...ctx.others].some((dir) =>
    isInside(dir, real),
  );

/**
 * Collects the candidate files of one listed path into `ctx.files` as
 * `{ rel, src, srcRel }`: `rel` is the path in the work tree, `src` the resolved
 * source file, `srcRel` its path in the main work tree. A symlink is followed only
 * when its target resolves inside the main work tree and outside `.git` and every
 * other work tree. A target outside, or a dangling link, is skipped by name, so no
 * symlink is followed out of the main work tree. A copy is always a regular file.
 * A directory link already on the walk chain is skipped, so a loop ends. A work
 * tree directory is dropped silently, because it holds a checkout.
 */
async function collect(ctx, rel, abs, chain) {
  if ((await lstatOrNull(abs)) === null) {
    return;
  }
  let real;
  try {
    real = await realpath(abs);
  } catch {
    ctx.skipped.add(rel);
    return;
  }
  const viaLink = !same(real, abs);
  if (!isInside(ctx.main, real) || isExcluded(ctx, real)) {
    if (viaLink) {
      ctx.skipped.add(rel);
    }
    return;
  }
  const stat = await lstat(real);
  if (stat.isFile()) {
    ctx.files.push({ rel, src: real, srcRel: relative(ctx.main, real).split(sep).join("/") });
    return;
  }
  if (!stat.isDirectory()) {
    return;
  }
  if (chain.has(real)) {
    ctx.skipped.add(rel);
    return;
  }
  if ((await lstatOrNull(join(real, ".git"))) !== null) {
    return;
  }
  const entries = await readdir(real);
  ctx.budget.left -= entries.length;
  if (ctx.budget.left < 0) {
    ctx.budget.exceeded = true;
    return;
  }
  for (const name of entries) {
    await collect(ctx, `${rel}/${name}`, join(real, name), new Set(chain).add(real));
  }
}

/**
 * Copies each untracked local file of the main work tree that is ignored in
 * `cwd`'s work tree into it, once, at init. A file is copied only when all three
 * hold: it exists in the main work tree, it is untracked there, and `git
 * check-ignore` in the linked work tree names it ignored. Never overwrites a file
 * of the linked work tree, never follows a symlink out of the main work tree,
 * never copies a work tree directory, `.git`, `.gitignore`, or `.gitattributes`,
 * and never writes through a symlinked directory of the linked work tree. A
 * symlink that resolves inside the main work tree is copied as a regular file.
 * Returns `{ copied, skipped }` as sorted root-relative path names, or null when
 * `cwd` is the main work tree or the repository is bare, where nothing is copied.
 * An untracked file that is not copied is in `skipped`. A listed directory that
 * holds more than `MAX_WALKED_ENTRIES` entries is in `skipped` as one name and
 * none of its files is copied.
 *
 * known-limit: the source is resolved with `realpath` and then copied by path, so
 * a concurrent writer in the main work tree can swap a file for a symlink between
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
  const mainReal = await realpath(trees.main);
  const others = await Promise.all(
    trees.others.map((other) => realpath(other).catch(() => resolve(other))),
  );

  const skipped = new Set();
  const files = [];
  for (const rel of LOCAL_FILE_PATHS) {
    // One bound and one result list per listed path, so a path past its bound is
    // dropped whole and never starves the next listed path.
    const ctx = {
      main: mainReal,
      others,
      files: [],
      skipped: new Set(),
      budget: { left: MAX_WALKED_ENTRIES, exceeded: false },
    };
    await collect(ctx, rel, join(mainReal, rel), new Set());
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
    // Tracked under the path in the work tree or under the resolved path: a
    // tracked file is not a local file, and it is not reported.
    if (tracked.has(file.rel) || tracked.has(file.srcRel)) {
      continue;
    }
    if (GIT_CONTROL_FILES.has(basename(file.rel)) || GIT_CONTROL_FILES.has(basename(file.srcRel))) {
      skipped.add(file.rel);
    } else if (
      (await lstatOrNull(join(root, file.rel))) !== null ||
      (await hasLinkedAncestor(root, file.rel))
    ) {
      skipped.add(file.rel);
    } else {
      pending.push(file);
    }
  }

  const ignored = new Set();
  if (pending.length > 0) {
    const result = await git(root, ["check-ignore", "-z", "--stdin"], {
      input: `${pending.map((file) => file.rel).join("\0")}\0`,
      allowExit: [1],
    });
    for (const rel of result.stdout.split("\0").filter(Boolean)) {
      ignored.add(rel);
    }
  }

  const copied = [];
  for (const { rel, src } of pending) {
    if (ignored.has(rel) && (await copyOne(src, join(root, rel)))) {
      copied.push(rel);
    } else {
      skipped.add(rel);
    }
  }

  logInfo(`local files: ${copied.length} copied, ${skipped.size} skipped`);
  return { copied: copied.sort(), skipped: [...skipped].sort() };
}

/** Copies one resolved source file without overwrite. Returns false when it is not copied. */
async function copyOne(source, target) {
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
