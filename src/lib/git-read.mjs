// One bounded `git` read, its error, the shared line-feed strip, and the work tree list parser, for
// every module.
import { AsyncLocalStorage } from "node:async_hooks";
import { execBounded } from "./exec.mjs";

// Milliseconds that one snapshot `git` read waits before it ends the child.
export const GIT_READ_TIMEOUT_MS = 120_000;

// Milliseconds that one work tree `git` read waits before it ends the child.
export const WORK_TREE_READ_TIMEOUT_MS = 60_000;

// Snapshot failure: a turn's mutation state is unknown, so no verdict exists.
// SnapshotError wins when a canceled turn's post-turn snapshot also fails. The caller then exits 1,
// not 130.
export class SnapshotError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotError";
    // True when a cancel ended the read, so a caller keeps exit 130.
    this.isCanceled = options?.isCanceled === true;
  }
}

/**
 * Removes the one line feed that Git prints after a single value. A path can end in a carriage
 * return, a space, or a line feed of its own.
 */
export const stripLf = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

// The identity reads of one command, keyed by read kind and the exact `cwd` string.
const identityReads = new AsyncLocalStorage();

/**
 * Runs `fn` with one identity-read memo, so a command reads the work tree top level and the common
 * Git directory once each. A failed read is never kept.
 */
export function withGitIdentityReads(fn) {
  return identityReads.run(new Map(), fn);
}

/** True when the current command already resolved the top level of the exact `cwd` string. */
export function hasTopLevel(cwd) {
  return identityReads.getStore()?.has(`top\0${cwd}`) === true;
}

async function identityRead(kind, cwd, read, args, options) {
  const fresh = async () => {
    const result = await read(cwd, args, options);
    return { ...result, stdout: stripLf(result.stdout) };
  };
  const store = identityReads.getStore();
  if (store === undefined) return fresh();
  const key = `${kind}\0${cwd}`;
  try {
    let pending = store.get(key);
    if (pending === undefined) {
      pending = fresh();
      store.set(key, pending);
    }
    const result = await pending;
    // A failed read is data for the caller, never a memoized answer.
    if (result.exitCode !== 0) store.delete(key);
    return result;
  } catch (err) {
    store.delete(key);
    throw err;
  }
}

/**
 * Reads the work tree top level of `cwd` and removes the one line feed that Git prints. A path that
 * ends in a carriage return or a space stays whole. Returns the read result. `read` is the
 * `gitRead`-shaped function to call.
 */
export async function readTopLevel(cwd, { read = gitRead, ...options } = {}) {
  return identityRead("top", cwd, read, ["rev-parse", "--show-toplevel"], {
    ...options,
    stripFinalNewline: false,
  });
}

/**
 * Reads the common Git directory of `cwd` and removes the one line feed that Git prints. Returns the
 * read result. `read` is the `gitRead`-shaped function to call.
 */
export async function readCommonDir(cwd, { read = gitRead, ...options } = {}) {
  return identityRead("common", cwd, read, ["rev-parse", "--git-common-dir"], {
    ...options,
    stripFinalNewline: false,
  });
}

/**
 * Parses `git worktree list --porcelain -z` into `{ path, bare, locked, reason }` entries, in Git's
 * order. Git ends every field with NUL, so a path that holds a newline arrives whole. A record is a
 * run of `<label> <value>` fields closed by an empty field. `locked` alone is a lock with no
 * reason, and `locked <reason>` names it.
 */
export function parseWorkTreeList(stdout) {
  const entries = [];
  let current = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      current = null;
    } else if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), bare: false, locked: false, reason: null };
      entries.push(current);
    } else if (current === null) {
      continue;
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "locked") {
      current.locked = true;
    } else if (field.startsWith("locked ")) {
      current.locked = true;
      current.reason = field.slice(7);
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice(7);
    }
  }
  return entries;
}

/**
 * Builds the error for one failed `git` read. The options keep each caller's message, error class,
 * and fields unchanged. `detail` and `exit` build the exit-code text and value, and the default
 * matches `snapshot`.
 */
export function gitReadError(
  reason,
  { args, timeoutMs, result },
  {
    errorClass = SnapshotError,
    prefix = "",
    detail = (value) => `: ${value.stderr.trim()}`,
    exit = (value) => value.exitCode,
  } = {},
) {
  if (reason === "canceled") {
    return Object.assign(new errorClass(`${prefix}git ${args[0]} was canceled`), {
      isCanceled: true,
    });
  }
  if (reason === "timeout") {
    return new errorClass(`${prefix}git ${args[0]} timed out after ${timeoutMs} ms`);
  }
  return new errorClass(`${prefix}git ${args[0]} failed (exit ${exit(result)})${detail(result)}`);
}

/**
 * Runs one bounded `git` read. A timeout or a cancel throws, because the read has no answer to
 * return. Any other exit code is data for the caller, unless `allowExit` lists the accepted exit
 * codes: then any other code throws too. `createError(reason, { args, timeoutMs, result })` builds
 * the error for `reason` `"canceled"` (it must set `isCanceled`), `"timeout"`, or `"exit"`. The
 * default builds a `SnapshotError`. Other options go to `execBounded`.
 */
export async function gitRead(
  cwd,
  args,
  {
    signal,
    timeoutMs = GIT_READ_TIMEOUT_MS,
    allowExit,
    createError = gitReadError,
    ...execOptions
  } = {},
) {
  const result = await execBounded("git", args, { cwd, timeoutMs, signal, ...execOptions });
  const context = { args, timeoutMs, result };
  if (result.isCanceled) {
    throw createError("canceled", context);
  }
  if (result.timedOut) {
    throw createError("timeout", context);
  }
  if (allowExit !== undefined && !allowExit.includes(result.exitCode)) {
    throw createError("exit", context);
  }
  return result;
}
