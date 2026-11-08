// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0018). Each file is copied with
// `copyFile` and `COPYFILE_EXCL`, so an existing file is never replaced or
// deleted. The module never prints, logs, or returns file content: every report
// is a path name.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapInBatches } from "./batches.mjs";
import {
  gitRead,
  gitReadError,
  parseWorkTreeList,
  readTopLevel,
  stripLf,
  WORK_TREE_READ_TIMEOUT_MS,
} from "./git-read.mjs";
import { sha256 } from "./hash.mjs";
import { logInfo, logWarn } from "./log.mjs";

// Paths that can configure a child CLI or a build. A directory is walked, and the
// three conditions apply to each file inside it.
const LOCAL_FILE_PATHS = [
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

// Names that one batch of file reads handles at once, so a long list never opens every file at once.
const READ_BATCH_SIZE = 32;

// Where Claude Code creates work trees. Other work tree paths come from
// `git worktree list` and from a nested `.git` entry.
const CLAUDE_WORKTREES = [".claude", "worktrees"];

// Claude Code names the holder of a lock in a `*.lock` file under `.claude/`, such as
// `scheduled_tasks.lock`. A copy would claim a lock that no process of the linked work
// tree holds, so the file is skipped and named (issue #964).
const isClaudeLockFile = (rel) =>
  foldName(rel.split("/")[0]) === ".claude" && foldName(basename(rel)).endsWith(".lock");

// A configuration file is small. A larger file is a cache, a log, or a session
// store, so it is skipped and named instead of duplicated into every run.
const MAX_FILE_BYTES = 1024 * 1024;

// Bounds the walk of one listed directory, counting every entry read under it,
// nested directories included. A listed directory that holds more than this is
// skipped by name as a whole, with none of its files copied, so a huge `.claude/`
// cannot stall the init or flood the report. Each listed path has its own bound.
export const MAX_WALKED_ENTRIES = 2000;

// Files that change how Git reads a work tree. Copying one can un-ignore a file
// that was copied or change its line endings, so the snapshot would list it and
// the run's reviewed state would shift (ADR 0018).
const GIT_CONTROL_FILES = new Set([".gitignore", ".gitattributes"]);

// Keeps the `local files` message and plain error class of the earlier builder.
const localReadError = (reason, context) =>
  gitReadError(reason, context, {
    errorClass: Error,
    prefix: "local files: ",
    detail: (result) => `: ${(result.stderr || result.code || "").trim()}`,
    exit: (result) => result.exitCode ?? "none",
  });

function git(cwd, args, { allowExit = [], ...options } = {}) {
  // `stripFinalNewline: false` (execa, `lib/io/strip-newline.js`) keeps the output
  // byte-exact. By default execa removes a final `\n` or `\r\n`, which can be part
  // of a path.
  return gitRead(cwd, args, {
    timeoutMs: WORK_TREE_READ_TIMEOUT_MS,
    stripFinalNewline: false,
    ...options,
    allowExit: [0, ...allowExit],
    createError: localReadError,
  });
}

/**
 * Folds a file name to the form that the strictest file system reads it as:
 * lower case, no stream suffix (`name:stream`), and no trailing dots or spaces.
 * Only the excluded names (`.git`, `.claude/worktrees`, `.gitignore`,
 * `.gitattributes`, and any `*.lock` under `.claude`) are compared this way. A folded match includes the exact
 * match, so folding can only skip more files, never read or write more. A path is
 * never folded: paths are compared as the canonical strings that `realpath`
 * returns.
 */
const foldName = (name) =>
  name
    .toLowerCase()
    .replace(/:.*$/s, "")
    .replace(/[. ]+$/, "");

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
 * The ancestor verdicts of one copy call, per blocked set. `true` is a blocked directory, `false` a
 * plain one, and `null` a missing one. Only the pre-filter passes read it, because `copyOne` checks
 * again before the copy.
 */
const newAncestorCache = () => ({ source: new Map(), target: new Map() });

/**
 * Walks the ancestor directories of `rel` under `base`, never `base` itself. Returns true for a
 * symlink, a directory that holds a `.git` entry, or a registered work tree listed in `blocked`
 * (canonical paths). With `create`, a missing ancestor is created one level at a time without
 * following anything. Without it, the walk stops at the first missing ancestor. `cache` holds the
 * verdicts of one copy call for the pre-filter passes only, because the copy checks again before
 * `copyFile`.
 */
async function hasBlockedAncestor(base, rel, blocked, create = false, cache = null) {
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
    const known = cache?.get(current);
    if (known !== undefined) {
      if (known === null) {
        return false;
      }
      if (known) {
        return true;
      }
      continue;
    }
    const stat = await lstatOrNull(current);
    if (stat === null) {
      cache?.set(current, null);
      return false;
    }
    const verdict =
      !stat.isDirectory() ||
      blocked.has(await realpath(current)) ||
      (await lstatOrNull(join(current, ".git"))) !== null;
    cache?.set(current, verdict);
    if (verdict) {
      return true;
    }
  }
  return false;
}

/** True when `path` holds a control character: a line feed, a carriage return, a tab, and so on. */
const hasControlCharacter = (path) =>
  Array.from(path, (character) => character.codePointAt(0)).some(
    (code) => code < 0x20 || code === 0x7f,
  );

/**
 * Reads `git worktree list --porcelain -z` into entries, in Git's order. A Git that rejects `-z`
 * fails the command, which fails the init.
 */
async function readWorkTrees(root, read) {
  const { stdout } = await read(root, ["worktree", "list", "--porcelain", "-z"]);
  return parseWorkTreeList(stdout);
}

const isInsideByText = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Returns `{ main }` with the canonical path of the main work tree, `{ main: null }` when there
 * is none for this copy, or `{ refused }` with the name of a path that holds a control
 * character (decision 10 of ADR 0018). The main work tree is the first entry of
 * `git worktree list --porcelain -z`, taken only when all three hold: the entry is
 * not marked `bare`, its path is an existing directory, and its canonical path is
 * neither the common Git directory (`git rev-parse --git-common-dir`) nor inside
 * it. Every other layout has none: a bare repository, a plain separate Git
 * directory, and a submodule, where Git lists the Git directory first. A Git
 * command that fails throws. The caller copies nothing for `{ refused }`.
 */
async function findMainWorkTree(root, entries, read) {
  const first = entries[0];
  if (first === undefined || first.bare || !(await lstatOrNull(first.path))?.isDirectory()) {
    return { main: null };
  }
  const common = stripLf((await read(root, ["rev-parse", "--git-common-dir"])).stdout);
  const commonReal = await realpath(resolve(root, common));
  const main = await realpath(first.path);
  if (hasControlCharacter(common) || hasControlCharacter(commonReal)) {
    return { refused: "the common Git directory path" };
  }
  if (hasControlCharacter(main)) {
    return { refused: "the main work tree path" };
  }
  return { main: isInsideByText(commonReal, main) ? null : main };
}

/**
 * Resolves the work trees of a copy or a comparison: returns `{ entries, mainReal, rootReal }`
 * (the registered work trees, and the canonical paths of the main and the linked work tree), or
 * null, with the reason logged, when nothing can be read from or written to: a path holds a
 * control character, there is no main work tree for this copy, or `cwd` is the main work tree.
 * The `quiet` option suppresses its log line.
 */
async function locateWorkTrees(cwd, read, { quiet = false } = {}) {
  // A path with a control character is not trusted to survive a round trip through
  // Git's output or a path comparison, so the copy refuses it and copies nothing.
  const refuse = (what) => {
    if (!quiet) logInfo(`local files: ${what} holds a control character, so nothing is copied`);
    return null;
  };
  if (hasControlCharacter(cwd)) {
    return refuse("--cwd");
  }
  const top = (await readTopLevel(cwd, { read })).stdout;
  if (hasControlCharacter(top)) {
    return refuse("the work tree path");
  }
  // The operator's own `--cwd` names the work tree when Git names the same
  // directory, so a Git echo of the path is not what the later commands run in.
  const root = (await realpath(cwd)) === (await realpath(top)) ? cwd : top;
  const entries = await readWorkTrees(root, read);
  if (entries.some((entry) => hasControlCharacter(entry.path))) {
    return refuse("a registered work tree path");
  }
  const found = await findMainWorkTree(root, entries, read);
  if (found.refused !== undefined) {
    return refuse(found.refused);
  }
  if (found.main === null) {
    if (!quiet) logInfo("local files: no main work tree found, so nothing is copied");
    return null;
  }
  const rootReal = await realpath(root);
  return found.main === rootReal ? null : { entries, mainReal: found.main, rootReal };
}

/**
 * Returns the canonical path of the main work tree for a linked `cwd`. The result is null when `cwd`
 * is the main work tree or the layout has none. The resolution matches the local-file copy.
 */
export async function mainWorkTreePath(cwd, { signal } = {}) {
  const located = await locateWorkTrees(
    cwd,
    (dir, args, options) => git(dir, args, { signal, ...options }),
    { quiet: true },
  );
  return located?.mainReal ?? null;
}

/**
 * Normalizes one operator path (`--copy-local-path`) to a root-relative path with `/`
 * separators. The path must name something inside the main work tree: an empty, absolute,
 * drive-qualified, or control-character path is refused, and so is any `.` or `..` segment,
 * `.git`, a checkout under `.claude/worktrees`, and a segment that holds `:` (a drive or a stream
 * name) or ends in a dot or a space (Windows reads it as another name). A trailing separator is
 * dropped.
 * @param {string} raw
 * @returns {string}
 * @throws {Error} with a message that starts `--copy-local-path`
 */
export function normalizeLocalPath(raw) {
  const refuse = (why) => new Error(`--copy-local-path ${JSON.stringify(raw)} is refused: ${why}`);
  if (typeof raw !== "string" || raw === "") {
    throw refuse("the path is empty");
  }
  if (hasControlCharacter(raw)) {
    throw refuse("the path holds a control character");
  }
  if (isAbsolute(raw) || /^([a-zA-Z]:|[\\/])/.test(raw)) {
    throw refuse("the path must be relative to the main work tree");
  }
  const parts = raw.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw refuse("the path must stay inside the main work tree");
  }
  if (parts.some((part) => part.includes(":") || /[. ]$/.test(part))) {
    throw refuse("a segment holds a colon or ends in a dot or a space");
  }
  const rel = parts.join("/");
  if (isExcludedRel(rel)) {
    throw refuse("the path holds repository state or a checkout");
  }
  return rel;
}

/**
 * The registered work trees that a read must never enter (`sourceBlocked`, inside the main work
 * tree) and a write must never enter (`targetBlocked`, inside the linked work tree), whether or not
 * their `.git` entry is still there.
 */
async function blockedTrees(entries, mainReal, rootReal) {
  const trees = await Promise.all(
    entries.map((entry) => realpath(entry.path).catch(() => resolve(entry.path))),
  );
  const sourceBlocked = new Set(trees);
  sourceBlocked.delete(mainReal);
  const targetBlocked = new Set([mainReal, ...trees]);
  targetBlocked.delete(rootReal);
  return { sourceBlocked, targetBlocked };
}

/** The names Git tracks in the work tree `dir`, as root-relative paths with `/` separators. */
async function listTrackedNames(dir, read) {
  return (await read(dir, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
}

/** The names among `names` that `git check-ignore` reports ignored in the work tree `root`. */
async function ignoredNames(read, root, names) {
  if (names.length === 0) {
    return new Set();
  }
  const result = await read(root, ["check-ignore", "-z", "--stdin"], {
    input: `${names.join("\0")}\0`,
    allowExit: [1],
  });
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/**
 * The work tree of `cwd` as both the source and the target of an operator path check, for a `cwd`
 * that has no main work tree to copy from (the main work tree itself, a bare layout, or a path with a
 * control character). Fails closed: a top-level path with a control character is refused, because a
 * path that Git could print cut short is not checked.
 */
async function ownWorkTree(cwd, read) {
  const top = (await readTopLevel(cwd, { read })).stdout;
  if (hasControlCharacter(cwd) || hasControlCharacter(top)) {
    throw new Error(
      "--copy-local-path cannot be checked: the work tree path holds a control character",
    );
  }
  const real = await realpath(top);
  const entries = await readWorkTrees(top, read);
  return { entries, mainReal: real, rootReal: real };
}

/**
 * Refuses, before any copy, an operator path that cannot be copied as an ignored local path.
 * Every path in `extra` must hold no tracked file, no link at any level, and no unignored file.
 * `known` holds the blocked sets and the tracked names that the copy reads once. `ancestors` holds
 * the ancestor verdicts of one copy call.
 * @throws {Error} that names the path and starts with `--copy-local-path`
 */
async function refuseUnsafeLocalPaths(tree, extra, known, read, maxEntries, ancestors) {
  const { mainReal, rootReal } = tree;
  const { sourceBlocked, targetBlocked, trackedNames } = known;
  // Every folded leading path of a tracked name, so each operator path is one lookup.
  const trackedPrefixes = new Set();
  for (const name of trackedNames) {
    let prefix = null;
    for (const part of name.split("/")) {
      prefix = prefix === null ? foldName(part) : `${prefix}/${foldName(part)}`;
      trackedPrefixes.add(prefix);
    }
  }
  // Each path in `extra` is already normalized, and every check runs in the main work tree.
  for (const rel of extra) {
    const refuse = (why) =>
      new Error(`--copy-local-path ${JSON.stringify(rel)} is refused: ${why}`);
    const parts = rel.split("/");
    const folded = parts.map(foldName).join("/");
    // Names are compared folded, so a case alias of a tracked name is refused on any file system.
    // The compare matches leading segments, so a path that names a tracked file or a directory
    // above it is refused.
    // That costs a false refusal on a case-sensitive file system for a path that is not a case
    // alias of a tracked path.
    if (trackedPrefixes.has(folded)) {
      throw refuse("it holds a tracked file");
    }
    let current = mainReal;
    // No level can be a symlink or a junction. The existing path must resolve, by `realpath`, to
    // the main work tree plus the path as written. That refuses a link out of the tree, a case or
    // short-name alias, a registered work tree, and a directory that holds a `.git` entry.
    for (const part of parts) {
      current = join(current, part);
      const stat = await lstatOrNull(current);
      if (stat === null) {
        break;
      }
      if (stat.isSymbolicLink()) {
        throw refuse("it passes through a symlink or a junction");
      }
    }
    const abs = join(mainReal, ...parts);
    // A path that does not exist passes, because nothing is copied for it.
    if ((await lstatOrNull(abs)) === null) {
      continue;
    }
    const canon = await realpath(abs);
    if (
      canon !== abs ||
      sourceBlocked.has(canon) ||
      (await lstatOrNull(join(abs, ".git"))) !== null ||
      (await hasBlockedAncestor(mainReal, rel, sourceBlocked, false, ancestors.source))
    ) {
      throw refuse("it does not resolve to a plain path inside the main work tree");
    }
    const ctx = newWalk(sourceBlocked, maxEntries);
    await collect(ctx, rel, abs);
    // A listed directory past the entry bound is skipped whole by the copy and is not checked.
    if (ctx.budget.exceeded) {
      continue;
    }
    const names = [];
    // Every file that the copy takes must be ignored in `rootReal`, the receiving work tree.
    for (const { rel: name } of ctx.files) {
      // The copy never takes these, so they need no ignore rule. A target beyond a link or a work
      // tree is skipped by the copy, and `git check-ignore` refuses such a path.
      if (
        !GIT_CONTROL_FILES.has(foldName(basename(name))) &&
        !isClaudeLockFile(name) &&
        !(await hasBlockedAncestor(rootReal, name, targetBlocked, false, ancestors.target))
      ) {
        names.push(name);
      }
    }
    const ignored = await ignoredNames(read, rootReal, names);
    const open = names.find((name) => !ignored.has(name));
    if (open !== undefined) {
      throw refuse(`${JSON.stringify(open)} is not ignored in the work tree`);
    }
  }
}

/** The state of one walk: a bound and a result list that belong to one listed path. */
const newWalk = (others, maxEntries) => ({
  others,
  files: [],
  skipped: new Set(),
  budget: { left: maxEntries, exceeded: false },
});

/**
 * Collects the candidate files of one listed path into `ctx.files` as
 * `{ rel, src, canon }`: `canon` is the canonical path of the file, which the copy
 * compares with the path it resolves again just before it reads. No symlink is followed: a symlink entry is skipped by name, and
 * so is a listed path under a symlinked directory, so every path that is read
 * lies inside the main work tree. `.git`, `.claude/worktrees`, every registered
 * work tree, and every directory that holds a `.git` entry (a file or a
 * directory) are dropped silently, because they hold repository state or a
 * checkout, not a local file.
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
    ctx.files.push({ rel, src: abs, canon: await realpath(abs) });
  } else if (
    stat.isDirectory() &&
    !ctx.others.has(await realpath(abs)) &&
    (await lstatOrNull(join(abs, ".git"))) === null
  ) {
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
 * check-ignore` in the linked work tree names it ignored. It never overwrites a
 * file of the linked work tree. Its checks refuse a symlink, `.git`, a registered
 * work tree, a directory that holds a `.git` entry, a `.gitignore` or
 * `.gitattributes`, a `*.lock` file under `.claude/`, and a target under a symlinked directory of the linked work
 * tree, as far as the approved limit below allows. The excluded names are matched
 * folded, which can only skip more; paths are compared as canonical strings from
 * `realpath`. Returns `{ copied, skipped }` as sorted root-relative path names, or
 * null, where nothing is copied, when there is no main work tree to copy from (`cwd`
 * is the main work tree, or the main work tree rule of `findMainWorkTree` finds none)
 * or when `--cwd`, the work tree path, a registered work tree path, or the common Git
 * directory or main work tree path holds a control character. A Git command that
 * fails while the main work tree is looked up throws, and fails the init. An
 * untracked file that is not copied is in `skipped`. A listed directory that holds more than
 * `MAX_WALKED_ENTRIES` entries is in `skipped` as one name and none of its files
 * is copied. A file whose check fails is in `skipped`.
 *
 * Approved limit (ADR 0018): Node has no descriptor-relative open, so a directory
 * or link swapped between a check and the `copyFile` call can redirect that read
 * or write. A swap needs local write access to the work trees during init.
 *
 * `extraPaths` (the operator's `--copy-local-path` values) are copied like the listed paths and
 * obey every rule above. Each must pass `normalizeLocalPath` and the checks of
 * `refuseUnsafeLocalPaths` (no tracked file, no link at any level, only ignored files). A refusal
 * throws before any copy, also when `cwd` is the main work tree and nothing would be copied, so the
 * init fails with no run left to abort.
 *
 * `hooks` is a test seam. `beforeSourceOpen` and `beforeCopy` run with the file's
 * path name just before the source is opened and just before `copyFile`.
 * `signal` ends a running `git` read, and the copy then rejects with `isCanceled` set.
 * `maxEntries` is a test seam for the bound of one listed directory. It is an integer from 1
 * through `MAX_WALKED_ENTRIES`, the default. Any other value throws a `RangeError`, so the seam
 * can lower the bound but never raise it.
 * @param {string} cwd
 * @param {{ beforeSourceOpen?: (rel: string) => Promise<void>, beforeCopy?: (rel: string) => Promise<void> }} [hooks]
 * @param {{ signal?: AbortSignal, maxEntries?: number, extraPaths?: string[] }} [options]
 * @returns {Promise<{ copied: string[], skipped: string[] } | null>}
 */
export async function copyLocalFiles(
  cwd,
  hooks = {},
  { signal, maxEntries = MAX_WALKED_ENTRIES, extraPaths = [] } = {},
) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_WALKED_ENTRIES) {
    throw new RangeError(
      `local files: maxEntries must be an integer from 1 through ${MAX_WALKED_ENTRIES}`,
    );
  }
  const extra = [...new Set(extraPaths.map(normalizeLocalPath))];
  const read = (dir, args, options) => git(dir, args, { signal, ...options });
  const located = await locateWorkTrees(cwd, read);
  // The operator paths are checked before anything is copied, and also when nothing is, so a
  // refused path fails the init for a `--cwd` that is the main work tree too.
  const tree = located ?? (extra.length > 0 ? await ownWorkTree(cwd, read) : null);
  if (tree === null) {
    return null;
  }
  const { entries, mainReal, rootReal } = tree;
  const ancestors = newAncestorCache();
  const { sourceBlocked, targetBlocked } = await blockedTrees(entries, mainReal, rootReal);
  const trackedNames = await listTrackedNames(mainReal, read);
  if (extra.length > 0) {
    await refuseUnsafeLocalPaths(
      tree,
      extra,
      { sourceBlocked, targetBlocked, trackedNames },
      read,
      maxEntries,
      ancestors,
    );
  }
  if (located === null) {
    return null;
  }
  const listed = [...new Set([...LOCAL_FILE_PATHS, ...extra])];
  const { files, skipped } = await walkListed(
    mainReal,
    listed,
    sourceBlocked,
    maxEntries,
    ancestors.source,
  );
  const trackedCanon = await canonOfTracked(mainReal, listed, trackedNames);
  const tracked = new Set(trackedNames);
  const pending = [];
  for (const file of files) {
    if (tracked.has(file.rel) || trackedCanon.has(file.canon)) {
      continue;
    }
    // The target checks come before `git check-ignore`, which refuses a path
    // beyond a symlink or inside a nested repository.
    if (
      GIT_CONTROL_FILES.has(foldName(basename(file.rel))) ||
      isClaudeLockFile(file.rel) ||
      (await lstatOrNull(join(rootReal, file.rel))) !== null ||
      (await hasBlockedAncestor(rootReal, file.rel, targetBlocked, false, ancestors.target))
    ) {
      skipped.add(file.rel);
    } else {
      pending.push(file);
    }
  }

  const ignored = await ignoredNames(
    read,
    rootReal,
    pending.map((file) => file.rel),
  );
  const copied = [];
  for (const file of pending) {
    const { rel } = file;
    if (ignored.has(rel) && (await copyOne(file, rootReal, targetBlocked, hooks))) {
      copied.push(rel);
    } else {
      skipped.add(rel);
    }
  }

  logInfo(`local files: ${copied.length} copied, ${skipped.size} skipped`);
  return { copied: copied.sort(), skipped: [...skipped].sort() };
}

/**
 * Walks each listed path of the main work tree `mainReal`. Returns `{ files, skipped }`: the
 * candidate files (see `collect`) and a set of skipped root-relative names. A path past its entry
 * bound, or under a blocked ancestor, is skipped whole and never starves the next listed path.
 * `cache` holds the ancestor verdicts of one copy call.
 */
async function walkListed(mainReal, listed, sourceBlocked, maxEntries, cache) {
  const skipped = new Set();
  const files = [];
  for (const rel of listed) {
    // One bound and one result list per listed path.
    const ctx = newWalk(sourceBlocked, maxEntries);
    const abs = join(mainReal, rel);
    if (
      (await lstatOrNull(abs)) !== null &&
      (await hasBlockedAncestor(mainReal, rel, sourceBlocked, false, cache))
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
  return { files, skipped };
}

/**
 * The canonical paths of the tracked names under the listed paths. A tracked file is tracked under
 * any spelling that reaches it, so such a name is also compared by canonical path: on a
 * case-insensitive file system `.claude/config` is the tracked `.Claude/config`.
 */
async function canonOfTracked(mainReal, listed, trackedNames) {
  const listedRoots = new Set(listed.map((path) => foldName(path.split("/")[0])));
  const names = trackedNames.filter((name) => listedRoots.has(foldName(name.split("/")[0])));
  const canons = await mapInBatches(names, READ_BATCH_SIZE, (name) =>
    realpath(join(mainReal, name)).catch(() => null),
  );
  return new Set(canons);
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * True when the path `path` still resolves to the canonical path `canon` that the
 * walk recorded, and names the regular file with the identity of `opened` (a
 * `bigint` `stat`). `realpath` (`fs.promises.realpath`, which has the semantics of
 * `fs.realpath.native`, unlike the callback `fs.realpath`) returns the on-disk spelling on a case-insensitive
 * file system and the exact spelling on a case-sensitive one, so the two strings
 * are equal exactly when no symlink and no other directory lies on the path, and
 * two directories that differ only in case are different directories. No guess
 * about the file system is needed.
 */
async function namesFile(path, canon, opened) {
  const [resolved, named] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
  return resolved === canon && named.isFile() && sameFile(opened, named);
}

/**
 * Copies one source file to `rootReal/rel` and returns true when `copyFile` did.
 * Each check fails closed: the file is skipped.
 * 1. Open the source without following a final symlink, and check that the opened
 *    file is the regular file within the size cap that the walk recorded.
 * 2. Create the missing target directories one level at a time, none through a
 *    symlink, none holding a `.git` entry, none a registered work tree.
 * 3. `copyFile` with `COPYFILE_EXCL`, which refuses an existing target and never
 *    deletes one.
 * The checks run before `copyFile`, which reads and writes by path. A swap in
 * between is the approved limit of `copyLocalFiles`.
 */
async function copyOne({ rel, src, canon }, rootReal, blocked, hooks) {
  let source = null;
  try {
    await hooks.beforeSourceOpen?.(rel);
    source = await open(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await source.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.size > BigInt(MAX_FILE_BYTES) ||
      !(await namesFile(src, canon, stat))
    ) {
      return false;
    }
    if (await hasBlockedAncestor(rootReal, rel, blocked, true)) {
      return false;
    }
    await hooks.beforeCopy?.(rel);
    await copyFile(src, join(rootReal, rel), constants.COPYFILE_EXCL);
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

const MISSING = Symbol("missing");
const NOT_COMPARABLE = Symbol("not comparable");

/** True for a non-empty relative path with no `..` segment and no empty segment. */
const isPlainRelativeName = (rel) =>
  typeof rel === "string" &&
  rel !== "" &&
  !isAbsolute(rel) &&
  !rel.split("/").some((part) => part === ".." || part === "");

/** True for a JSON object, never an array or null. */
const isPlainRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
    // first probe is not comparable, never "missing": an absence after the probe is not proven.
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
 * Hashes each named file of the copy root. `names` is the `copied` list of the init copy.
 * Returns a plain object of path to SHA-256 hex, or an empty object when there is no main work
 * tree. A name that cannot be hashed is left out, so the later compare fails closed for it.
 * Content is never returned or logged. `afterAncestorCheck` and `beforeRead` are test seams.
 * @param {string} cwd
 * @param {string[]} names
 * @param {{ signal?: AbortSignal, afterAncestorCheck?: (path: string) => Promise<void>, beforeRead?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function hashCopiedLocalFiles(cwd, names, { signal, ...hooks } = {}) {
  return hashCopiedNames(cwd, names, { signal, ...hooks }, (located) => located.rootReal);
}

/**
 * Hashes each named source file in the main work tree of a linked `cwd`. The result shape and the
 * failure rules match `hashCopiedLocalFiles`. A turn window compares two results to name the
 * sources that a turn changed.
 * @param {string} cwd
 * @param {string[]} names
 * @param {{ signal?: AbortSignal, afterAncestorCheck?: (path: string) => Promise<void>, beforeRead?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function hashCopiedLocalSources(cwd, names, { signal, ...hooks } = {}) {
  return hashCopiedNames(cwd, names, { signal, ...hooks }, (located) => located.mainReal);
}

async function hashCopiedNames(cwd, names, { signal, ...hooks }, baseOf) {
  const located = await locateWorkTrees(cwd, (dir, args, options) =>
    git(dir, args, { signal, ...options }),
  );
  if (located === null) {
    return {};
  }
  const base = baseOf(located);
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
  const located = await locateWorkTrees(cwd, (dir, args, options) =>
    git(dir, args, { signal, ...options }),
  );
  if (located === null) {
    return [];
  }
  const hashes = isPlainRecord(initHashes) ? initHashes : null;
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
  if (typeof init !== "string" || !/^[0-9a-f]{64}$/.test(init)) {
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
 * Copies one source file over its run copy and returns the hash of the bytes written.
 * Reads the source once, then writes those bytes through a temporary file and a rename.
 * The temporary file starts at 0600, then takes the copy's prior mode on the open handle.
 * Refuses before any write when a side is missing or unreadable, a link sits on the path, or the
 * copy differs from `expectedCopyHash`. Content and hashes never reach a log line or an error text.
 * @param {string} cwd
 * @param {string} rel
 * @param {{ signal?: AbortSignal, expectedCopyHash?: string, beforeWrite?: (path: string) => Promise<void>, beforeTempCreate?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<string>} the new SHA-256 of the copy
 * @throws {Error} with a message that starts `refresh-local`
 */
export async function refreshLocalFile(
  cwd,
  rel,
  { signal, expectedCopyHash, beforeWrite, beforeTempCreate } = {},
) {
  const refuse = (why) => new Error(`refresh-local is refused: ${why}`);
  if (!isPlainRelativeName(rel)) {
    throw refuse("the path must stay inside the work tree");
  }
  const located = await locateWorkTrees(cwd, (dir, args, options) =>
    git(dir, args, { signal, ...options }),
  );
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
  const temp = join(dirname(target), `.refresh-${randomUUID()}.tmp`);
  await beforeTempCreate?.(temp);
  // Remove the temporary path only after this call creates it.
  let created = false;
  let handle = null;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    await handle.writeFile(source.bytes);
    // Set the prior copy mode on the handle, so the umask cannot widen it.
    await handle.chmod(copy.mode);
    await handle.close();
    handle = null;
    await rename(temp, target);
  } catch (err) {
    await handle?.close().catch(() => {});
    if (created) {
      await rm(temp, { force: true }).catch(() => {});
    }
    throw refuse(`the copy failed (${err.code ?? "error"})`);
  }
  return source.hash;
}

/**
 * Names the copied local files whose content differs from the file of the same name in the main
 * work tree, so a parent can see a stale copy. `names` is the `copied` list of the init copy.
 * Content is compared by SHA-256 and is never returned or logged. Nothing is written: a copy that
 * a turn changed is reported like one that the main work tree outgrew. A name that is not a plain
 * relative path, a link on the file or on any directory above it (in either work tree), a file
 * over 1 MiB (even when both sides are over), and a file missing from one side count as differing,
 * and no link is read through. Only a name that is missing from both sides is not reported.
 * Returns sorted path names, or an empty list when there is no main work tree.
 * @param {string} cwd
 * @param {string[]} names
 * `afterAncestorCheck` and `beforeRead` are test seams that run with the absolute path after the
 * ancestor check and just before the file is opened.
 * @param {{ signal?: AbortSignal, afterAncestorCheck?: (path: string) => Promise<void>, beforeRead?: (path: string) => Promise<void> }} [options]
 * @returns {Promise<string[]>}
 */
export async function findDifferingLocalFiles(cwd, names, { signal, ...hooks } = {}) {
  const located = await locateWorkTrees(cwd, (dir, args, options) =>
    git(dir, args, { signal, ...options }),
  );
  if (located === null) {
    return [];
  }
  const differs = await mapInBatches(names, READ_BATCH_SIZE, async (rel) => {
    if (!isPlainRelativeName(rel)) {
      return true;
    }
    const [source, copy] = await Promise.all([
      sha256Of(located.mainReal, rel, hooks),
      sha256Of(located.rootReal, rel, hooks),
    ]);
    return source === NOT_COMPARABLE || copy === NOT_COMPARABLE || source !== copy;
  });
  return names
    .filter((_, index) => differs[index])
    .map(String)
    .sort();
}
