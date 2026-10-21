// Copies untracked, ignored local agent and environment files from the main work
// tree into a linked run work tree (ADR 0018). Each file is copied with
// `copyFile` and `COPYFILE_EXCL`, so an existing file is never replaced or
// deleted. The module never prints, logs, or returns file content: every report
// is a path name.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { logInfo, logWarn } from "./log.mjs";
import { gitRead } from "./snapshot.mjs";

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

// Milliseconds that one `git` read waits before it ends the child.
const GIT_READ_TIMEOUT_MS = 60_000;

function gitReadError(reason, { args, timeoutMs, result }) {
  if (reason === "canceled") {
    return Object.assign(new Error(`local files: git ${args[0]} was canceled`), {
      isCanceled: true,
    });
  }
  if (reason === "timeout") {
    return new Error(`local files: git ${args[0]} timed out after ${timeoutMs} ms`);
  }
  // `shortMessage` holds the whole command line, so the fallback is the error code.
  const detail = (result.stderr || result.code || "").trim();
  return new Error(
    `local files: git ${args[0]} failed (exit ${result.exitCode ?? "none"}): ${detail}`,
  );
}

function git(cwd, args, { allowExit = [], ...options } = {}) {
  // `stripFinalNewline: false` (execa, `lib/io/strip-newline.js`) keeps the output
  // byte-exact. By default execa removes a final `\n` or `\r\n`, which can be part
  // of a path.
  return gitRead(cwd, args, {
    timeoutMs: GIT_READ_TIMEOUT_MS,
    stripFinalNewline: false,
    ...options,
    allowExit: [0, ...allowExit],
    createError: gitReadError,
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
 * Walks the ancestor directories of `rel` under `base`, never `base` itself, and
 * returns true when one of them must not be read or written through: a symlink, a
 * directory that holds a `.git` entry, or a registered work tree listed in
 * `blocked` (canonical paths). With `create`, a missing ancestor is created, one
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
      blocked.has(await realpath(current)) ||
      (await lstatOrNull(join(current, ".git"))) !== null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Removes the one line feed that Git prints after a single value, and nothing
 * else: a path can end in a carriage return, a space, or a line feed of its own.
 */
const stripLf = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** True when `path` holds a control character: a line feed, a carriage return, a tab, and so on. */
const hasControlCharacter = (path) =>
  Array.from(path, (character) => character.codePointAt(0)).some(
    (code) => code < 0x20 || code === 0x7f,
  );

/**
 * Reads `git worktree list --porcelain -z` into `{ path, bare }` entries, in Git's
 * order. With `-z` Git ends every field with NUL, so a path that holds a newline
 * arrives whole; the Git documentation states that this makes the output parseable
 * for such a path. A record is a run of `<label> <value>` fields (`worktree <path>`
 * first, a bare `bare` field for a bare repository) closed by an empty field. A Git
 * that rejects `-z` fails the command, which fails the init. An entry that Git still
 * lists counts as a work tree even when its `.git` entry is gone.
 */
async function readWorkTrees(root, read) {
  const { stdout } = await read(root, ["worktree", "list", "--porcelain", "-z"]);
  const entries = [];
  let current = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      current = null;
    } else if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), bare: false };
      entries.push(current);
    } else if (field === "bare" && current !== null) {
      current.bare = true;
    }
  }
  return entries;
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
 */
async function locateWorkTrees(cwd, read) {
  // A path with a control character is not trusted to survive a round trip through
  // Git's output or a path comparison, so the copy refuses it and copies nothing.
  const refuse = (what) => {
    logInfo(`local files: ${what} holds a control character, so nothing is copied`);
    return null;
  };
  if (hasControlCharacter(cwd)) {
    return refuse("--cwd");
  }
  const top = stripLf((await read(cwd, ["rev-parse", "--show-toplevel"])).stdout);
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
    logInfo("local files: no main work tree found, so nothing is copied");
    return null;
  }
  const rootReal = await realpath(root);
  return found.main === rootReal ? null : { entries, mainReal: found.main, rootReal };
}

/**
 * Normalizes one operator path (`--copy-local-path`) to a root-relative path with `/`
 * separators. The path must name something inside the main work tree: an empty, absolute,
 * drive-qualified, or control-character path is refused, and so is any `.` or `..` segment,
 * `.git`, or a checkout under `.claude/worktrees`. A trailing separator is dropped.
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
  const rel = parts.join("/");
  if (isExcludedRel(rel)) {
    throw refuse("the path holds repository state or a checkout");
  }
  return rel;
}

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
 * obey every rule above. Each must pass `normalizeLocalPath`, and one that holds a file tracked in
 * the main work tree is refused. Either refusal throws before any copy, so the init fails with no
 * run left to abort.
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
  const extra = extraPaths.map(normalizeLocalPath);
  const read = (dir, args, options) => git(dir, args, { signal, ...options });
  const located = await locateWorkTrees(cwd, read);
  if (located === null) {
    return null;
  }
  const { entries, mainReal, rootReal } = located;
  for (const rel of extra) {
    const held = await read(mainReal, ["ls-files", "-z", "--", `:(literal)${rel}`]);
    if (held.stdout !== "") {
      throw new Error(
        `--copy-local-path ${JSON.stringify(rel)} is refused: it holds a tracked file`,
      );
    }
  }
  const listed = [...new Set([...LOCAL_FILE_PATHS, ...extra])];
  // A registered work tree is never read from (inside the main work tree) and
  // never written into (inside the linked work tree), whether or not its `.git`
  // entry is still there.
  const trees = await Promise.all(
    entries.map((entry) => realpath(entry.path).catch(() => resolve(entry.path))),
  );
  const sourceBlocked = new Set(trees);
  sourceBlocked.delete(mainReal);
  const targetBlocked = new Set([mainReal, ...trees]);
  targetBlocked.delete(rootReal);

  const skipped = new Set();
  const files = [];
  for (const rel of listed) {
    // One bound and one result list per listed path, so a path past its bound is
    // dropped whole and never starves the next listed path.
    const ctx = {
      others: sourceBlocked,
      files: [],
      skipped: new Set(),
      budget: { left: maxEntries, exceeded: false },
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

  const trackedNames = (await read(mainReal, ["ls-files", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  // A tracked file is tracked under any spelling that reaches it, so the tracked
  // names under the listed paths are also compared by canonical path: on a
  // case-insensitive file system `.claude/config` is the tracked `.Claude/config`.
  const listedRoots = new Set(listed.map((path) => foldName(path.split("/")[0])));
  const tracked = new Set(trackedNames);
  const trackedCanon = new Set();
  for (const name of trackedNames) {
    if (listedRoots.has(foldName(name.split("/")[0]))) {
      trackedCanon.add(await realpath(join(mainReal, name)).catch(() => null));
    }
  }
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
      (await hasBlockedAncestor(rootReal, file.rel, targetBlocked))
    ) {
      skipped.add(file.rel);
    } else {
      pending.push(file);
    }
  }

  const ignored = new Set();
  if (pending.length > 0) {
    const result = await read(rootReal, ["check-ignore", "-z", "--stdin"], {
      input: `${pending.map((file) => file.rel).join("\0")}\0`,
      allowExit: [1],
    });
    for (const rel of result.stdout.split("\0").filter(Boolean)) {
      ignored.add(rel);
    }
  }

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

/**
 * Returns the SHA-256 of the regular file `rel` under `base` (a canonical path), `MISSING` when
 * the first probe finds no file, or `NOT_COMPARABLE` when it cannot be compared: a link on the
 * final entry or on any ancestor below `base`, a non-regular file, a file over the size cap, a
 * path that does not resolve to `base` plus `rel`, or a file that changed or vanished after the
 * first probe. The caller never counts `NOT_COMPARABLE` as equal, even when both sides return it.
 *
 * Order, so that no read starts on a path that is not proven inside `base`:
 * 1. Resolve the canonical path and `lstat` the file. An absence here is the only `MISSING`.
 * 2. Require the canonical path to equal `base` plus `rel`, then check the ancestors, then
 *    resolve the path again and require the same canonical path.
 * 3. Open the file. `O_NOFOLLOW` is 0 on Windows, so the identity checks carry the guard: the
 *    open handle must be the regular file with the `dev` and `ino` of the first `lstat`, and the
 *    path must still resolve to the same canonical path.
 * 4. Read from the handle only, then check the ancestors and the canonical path again.
 * Any mismatch, and any error after step 1, is `NOT_COMPARABLE`.
 * known-limit: a swap that is made and undone between two checks is not detected. A swap that
 * stays in place is caught before the read. The swap needs local write access to the work trees.
 * Node has no descriptor-relative open.
 */
async function sha256Of(base, rel, { beforeRead, afterAncestorCheck } = {}) {
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
    const hash = createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
    if (
      (await hasBlockedAncestor(base, rel, new Set())) ||
      !(await namesFile(path, canon, opened))
    ) {
      return NOT_COMPARABLE;
    }
    return hash;
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
  const differing = [];
  for (const rel of names) {
    if (
      typeof rel !== "string" ||
      rel === "" ||
      isAbsolute(rel) ||
      rel.split("/").some((part) => part === ".." || part === "")
    ) {
      differing.push(String(rel));
      continue;
    }
    const [source, copy] = await Promise.all([
      sha256Of(located.mainReal, rel, hooks),
      sha256Of(located.rootReal, rel, hooks),
    ]);
    if (source === NOT_COMPARABLE || copy === NOT_COMPARABLE || source !== copy) {
      differing.push(rel);
    }
  }
  return differing.sort();
}
