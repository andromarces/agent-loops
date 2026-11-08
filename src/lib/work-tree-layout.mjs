// The work-tree layout of a linked directory: the top-level path, the registered work trees,
// the canonical-path match, and the main work tree (ADR 0018, ADR 0073). The local-file copy
// and the work tree lock share it.
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalPath } from "./canonical-path.mjs";
import {
  gitRead,
  gitReadError,
  parseWorkTreeList,
  readTopLevel,
  stripLf,
  WORK_TREE_READ_TIMEOUT_MS,
} from "./git-read.mjs";
import { logInfo } from "./log.mjs";

/** An `lstat` that returns null for a missing path, and throws every other error. */
export async function lstatOrNull(path, options) {
  try {
    return await lstat(path, options);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return null;
    }
    throw err;
  }
}

/** True when `path` holds a control character: a line feed, a carriage return, a tab, and so on. */
export const hasControlCharacter = (path) =>
  Array.from(path, (character) => character.codePointAt(0)).some(
    (code) => code < 0x20 || code === 0x7f,
  );

/**
 * Reads `git worktree list --porcelain -z` into entries, in Git's order. A Git that rejects `-z`
 * fails the command, which fails the init.
 */
export async function readWorkTrees(root, read, { signal } = {}) {
  const result = await read(root, ["worktree", "list", "--porcelain", "-z"], {
    timeoutMs: WORK_TREE_READ_TIMEOUT_MS,
    stripFinalNewline: false,
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error("git worktree failed"), { exitCode: result.exitCode });
  }
  return parseWorkTreeList(result.stdout);
}

const isInsideByText = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Returns `{ main }`, `{ main: null }`, or `{ refused }` with the name of a path that holds a
 * control character (decision 10 of ADR 0018).
 *
 * The main work tree is the first entry of `git worktree list --porcelain -z`. It is taken only
 * when three conditions hold. The entry is not marked `bare`, its path is an existing directory,
 * and its canonical path is neither the common Git directory nor inside it.
 *
 * Every other layout has none: a bare repository, a plain separate Git directory, and a
 * submodule, where Git lists the Git directory first. A Git command that fails throws, and the
 * caller copies nothing for `{ refused }`.
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
 * Resolves the work trees of a copy or a comparison and returns `{ entries, mainReal, rootReal }`.
 * `entries` holds the registered work trees, and `mainReal` and `rootReal` are the canonical
 * paths of the main and linked work tree. Returns null when nothing can be read from or written
 * to. That holds when a path holds a control character, there is no main work tree, or `cwd` is
 * the main work tree. The reason is logged, and the `quiet` option suppresses that log line.
 */
export async function locateWorkTrees(cwd, read, { quiet = false } = {}) {
  // A path with a control character is not trusted to survive a round trip through Git's output
  // or a path comparison. The copy refuses it and copies nothing.
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
  // The operator's own `--cwd` names the work tree when Git names the same directory. A Git echo
  // of the path is therefore not what the later commands run in.
  const cwdReal = await realpath(cwd);
  const topReal = top === cwd ? cwdReal : await realpath(top);
  const root = cwdReal === topReal ? cwd : top;
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
  const rootReal = root === cwd ? cwdReal : topReal;
  return found.main === rootReal ? null : { entries, mainReal: found.main, rootReal };
}

/** The entry of `entries` that names `root`, or null. */
async function findOwn(root, entries, rootReal) {
  for (const candidate of entries) {
    if (candidate.path === root || (await canonicalPath(candidate.path)) === rootReal) {
      return candidate;
    }
  }
  return null;
}

/**
 * Reads the work tree root of `cwd` and the registered work trees. `root` is the operator's `cwd`
 * string when Git names the same directory, else Git's top-level echo. `own` is the entry that
 * names the root, or null. A failed read throws.
 */
export async function readWorkTreeLayout(cwd, read, { signal } = {}) {
  const options = {
    timeoutMs: WORK_TREE_READ_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  };
  const topResult = await readTopLevel(cwd, { read, ...options });
  if (topResult.exitCode !== 0) {
    throw Object.assign(new Error("git rev-parse failed"), { exitCode: topResult.exitCode });
  }
  const top = topResult.stdout;
  if (top === "") {
    throw new Error("cwd has no work tree root");
  }
  const cwdReal = await realpath(cwd);
  const topReal = top === cwd ? cwdReal : await realpath(top);
  const root = cwdReal === topReal ? cwd : top;
  const entries = await readWorkTrees(root, read, { signal });
  const rootReal = root === cwd ? cwdReal : topReal;
  const own = await findOwn(root, entries, rootReal);
  return { top, root, rootReal, entries, own };
}

const workTreeReadError = (reason, context) =>
  gitReadError(reason, context, { errorClass: Error, prefix: "work tree: " });

export function readWorkTree(cwd, args, { signal, ...options } = {}) {
  return gitRead(cwd, args, {
    timeoutMs: WORK_TREE_READ_TIMEOUT_MS,
    stripFinalNewline: false,
    ...options,
    ...(signal === undefined ? {} : { signal }),
    allowExit: [0],
    createError: workTreeReadError,
  });
}

/**
 * Returns the canonical path of the main work tree for a linked `cwd`. The result is null when `cwd`
 * is the main work tree or the layout has none. The resolution matches the local-file copy.
 */
export async function mainWorkTreePath(cwd, { signal } = {}) {
  const located = await locateWorkTrees(
    cwd,
    (dir, args, options) => readWorkTree(dir, args, { signal, ...options }),
    { quiet: true },
  );
  return located?.mainReal ?? null;
}
