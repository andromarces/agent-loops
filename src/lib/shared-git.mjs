import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { entryCarrier } from "./entry-report.mjs";
import { sha256 } from "./hash.mjs";
import { gitRead, SnapshotError } from "./snapshot.mjs";
import { withTimeBound } from "./time-bound.mjs";

// Item name of the hooks path setting in a shared Git state diff.
const HOOKS_PATH_ITEM = "core.hooksPath";

// Shared config keys that change how Git treats the main work tree. The read names a key only.
const SHARED_CONFIG_KEYS = new Set(["core.bare", "core.worktree"]);

// Scopes a turn can change. The system scope needs administrator rights and stays out.
const CONFIG_SCOPES = new Set(["global", "local", "worktree"]);

// Scope label of the main work tree's worktree config, read from the common Git directory.
const MAIN_WORK_TREE_SCOPE = "mainWorkTree";

const isSharedConfigKey = (key) => {
  // A name with three parts is a subsection, and a subsection can hold a URL.
  if (key.split(".").length !== 2) return false;
  return SHARED_CONFIG_KEYS.has(key) || key.startsWith("extensions.");
};

/**
 * Reads the Git state that every work tree of a repository shares and that a turn can change from
 * a linked work tree: `core.hooksPath`, the hook files in the common `hooks/` directory, and the
 * configured remotes. `core.hooksPath` and the remotes come from the local and the worktree scope
 * on their own: the effective value of `core.hooksPath` would hide a change to the scope that the
 * other one overrides. The result holds digests only, so a config value or a URL never leaves this
 * function. An unexpected `git` exit throws a `SnapshotError`, because an empty state would read as
 * a change.
 *
 * The read starts two `git` processes at once, because every worker turn reads twice and
 * a process start is slow on Windows. `bound` takes `signal` and `timeoutMs`, as for `snapshot`,
 * and `deadlineMs`, which stops the whole read: the `git` processes, the directory read, and the
 * hashing. The deadline joins `signal`, so either one stops the read. After it, no new file system
 * request starts, the `git` processes end (SIGTERM, then SIGKILL after 1 s), and the read rejects
 * with a `SnapshotError` that names the deadline. A read that needs no turn signal, such as the one
 * after a cancel, sets the deadline.
 *
 * known-limit: a file system request already in flight cannot be stopped. The read stops waiting
 * for it, and it can stay pending in the background when the file system stalls. Between the
 * requests of one hook hash, the read checks the signal, so no new request starts after the stop.
 *
 * The read also covers the global config, the main work tree's worktree config, and the shared
 * `core.bare`, `core.worktree`, and `extensions.*` keys. It names each changed key only, never a
 * value. The field reports a change observed between the two reads and does not prove the turn
 * made it. A global change can come from another process or another run on the host. A third
 * `git` process reads the main work tree's worktree config after the common directory resolves.
 * @returns {Promise<{ hooksPath: string, hooks: Record<string, string | null>, remotes: Record<string, string>, sharedKeys: Record<string, string> }>}
 */
export async function readSharedGit(cwd, { deadlineMs, signal, ...bound } = {}) {
  if (deadlineMs === undefined) return readWithin(cwd, { ...bound, signal });
  return withTimeBound(deadlineMs, undefined, async ({ signal: deadline }) => {
    try {
      return await readWithin(cwd, {
        ...bound,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch (err) {
      if (deadline.aborted) {
        throw new SnapshotError(`the shared Git read took over ${deadlineMs} ms`);
      }
      throw err;
    }
  });
}

async function readWithin(cwd, bound) {
  const read = (args, options = {}) =>
    gitRead(cwd, args, { ...bound, ...options, allowExit: [0], createError: readFailure });
  // Both processes end before the read rejects, so none outlives a stopped read.
  const settled = await Promise.allSettled([
    read(["rev-parse", "--git-common-dir"]),
    read(["config", "-z", "--list", "--show-scope"]),
  ]);
  const failed = settled.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  const [commonResult, listResult] = settled.map((outcome) => outcome.value);
  const commonDir = commonResult.stdout.trim();
  const commonPath = isAbsolute(commonDir) ? commonDir : join(cwd, commonDir);
  const state = readConfigState(listResult.stdout);
  // The main work tree's own worktree config lives in the common directory. Git reads it only when
  // the extension is on, and this read keeps that behavior. The explicit work tree stops a
  // `core.worktree` value from failing the read.
  const mainResult = await read(["config", "-z", "--list", "--show-scope"], {
    env: { ...bound.env, GIT_DIR: commonPath, GIT_WORK_TREE: cwd },
  });
  readConfigState(mainResult.stdout, state, { mainWorkTree: true });
  const { hooksPath, remotes, sharedKeys } = hashConfigState(state);

  return {
    hooksPath,
    hooks: await readHooks(join(commonPath, "hooks"), bound.signal),
    remotes,
    sharedKeys,
  };
}

// Names the failed `git` operation and the exit code only: git stderr can carry a config value,
// for example the path of an `include.path` entry, and the error reaches the log.
function readFailure(reason, { args, timeoutMs, result }) {
  if (reason === "canceled") {
    return new SnapshotError(`git ${args[0]} was canceled`, { isCanceled: true });
  }
  if (reason === "timeout") {
    return new SnapshotError(`git ${args[0]} timed out after ${timeoutMs} ms`);
  }
  return new SnapshotError(`git ${args[0]} failed (exit ${result.exitCode})`);
}

// With `-z` and `--show-scope`, each entry is `<scope>NUL<key>LF<value>NUL`, and a key with no
// value has no LF. Git writes the variable name in lower case. `mainWorkTree` keeps only the
// worktree scope of a listing read from the common Git directory.
function readConfigState(
  listing,
  state = {
    hooksPath: { global: [], local: [], worktree: [], [MAIN_WORK_TREE_SCOPE]: [] },
    remotes: new Map(),
    sharedKeys: new Map(),
  },
  { mainWorkTree = false } = {},
) {
  const { hooksPath, remotes, sharedKeys } = state;
  const tokens = listing.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    let scope = tokens[i];
    if (!CONFIG_SCOPES.has(scope)) continue;
    if (mainWorkTree) {
      if (scope !== "worktree") continue;
      scope = MAIN_WORK_TREE_SCOPE;
    }
    const entry = tokens[i + 1];
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    const lowerKey = key.toLowerCase();
    if (key === "core.hookspath") {
      hooksPath[scope].push(value);
    } else if (scope !== "global" && key.startsWith("remote.")) {
      const remoteName = key.slice("remote.".length, key.lastIndexOf("."));
      remotes.set(remoteName, [...(remotes.get(remoteName) ?? []), [scope, entry]]);
    } else if (isSharedConfigKey(lowerKey)) {
      // The value list, never the key spelling, is the state. Git prints the name in lower case.
      // A value list that keeps its order but changes a value is still a change.
      sharedKeys.set(lowerKey, [...(sharedKeys.get(lowerKey) ?? []), [scope, value]]);
    }
  }
  return state;
}

function hashConfigState({ hooksPath, remotes, sharedKeys }) {
  return {
    hooksPath: sha256(JSON.stringify(hooksPath)),
    remotes: Object.fromEntries(
      // The list keeps git's order: the first URL of a remote is the one `git remote get-url` returns.
      [...remotes].map(([name, list]) => [name, sha256(JSON.stringify(list))]),
    ),
    sharedKeys: Object.fromEntries(
      [...sharedKeys].map(([name, list]) => [name, sha256(JSON.stringify(list))]),
    ),
  };
}

// A Node file system error message carries the path, and a hook path or a symlink target can carry
// a secret, so a hook failure names the operation and the error code only and keeps no `cause`.
function hookFailure(operation, err) {
  const code =
    typeof err?.code === "string" && /^[A-Z0-9_]+$/.test(err.code) ? err.code : "unknown";
  return new SnapshotError(`${operation} failed (${code})`);
}

const canceled = () => new SnapshotError("the shared Git read was canceled", { isCanceled: true });

// Runs one file system request unless `signal` has aborted, and stops waiting for it when `signal`
// aborts. The request itself cannot be stopped.
function whileNotAborted(signal, request) {
  if (!signal) return request();
  if (signal.aborted) throw canceled();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(canceled());
    signal.addEventListener("abort", onAbort, { once: true });
    request()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// Hashes a hook file like `sha256File` does, but checks `signal` before each file system request, so
// no request starts after an abort. A symlink hashes its link text, and a file that is absent or
// neither a file nor a link reads as null.
async function hashHook(path, signal) {
  let stat;
  try {
    stat = await whileNotAborted(signal, () => lstat(path));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    return sha256(`symlink\0${await whileNotAborted(signal, () => readlink(path))}`);
  }
  if (!stat.isFile()) return null;
  try {
    return sha256(await whileNotAborted(signal, () => readFile(path)));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// A `.sample` file is the template `git init` writes, never an active hook.
async function readHooks(hooksDir, signal) {
  let names;
  try {
    names = await whileNotAborted(signal, () => readdir(hooksDir));
  } catch (err) {
    if (err.isCanceled) throw err;
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return {};
    throw hookFailure("the hooks directory read", err);
  }
  const hooks = {};
  for (const name of names.filter((n) => !n.endsWith(".sample")).sort()) {
    try {
      hooks[name] = await hashHook(join(hooksDir, name), signal);
    } catch (err) {
      if (err.isCanceled) throw err;
      throw hookFailure("a hook file read", err);
    }
  }
  return hooks;
}

/**
 * Names the shared Git items that differ between two `readSharedGit` results: `core.hooksPath`,
 * `hooks/<file>`, `remote.<name>`, and a shared config key such as `core.bare`. Never a value.
 * Returns a sorted list, empty when none changed.
 */
export function diffSharedGit(before, after) {
  const changed = [];
  if (before.hooksPath !== after.hooksPath) changed.push(HOOKS_PATH_ITEM);
  for (const name of differing(before.hooks, after.hooks)) changed.push(`hooks/${name}`);
  for (const name of differing(before.remotes, after.remotes)) changed.push(`remote.${name}`);
  for (const name of differing(before.sharedKeys, after.sharedKeys)) changed.push(name);
  return changed.sort();
}

const carrier = entryCarrier("sharedGitChanged");

/**
 * Carries the item names on a fatal error as `err.sharedGitChanged`. A frozen error or a throwing
 * setter keeps the original error, and the names stay readable through `failedSharedGitChanged`.
 */
export const carrySharedGitChanged = carrier.carry;

/** Returns the item names a fatal error carries, or `undefined` when it carries none. */
export const failedSharedGitChanged = carrier.failed;

function differing(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
}
