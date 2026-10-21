import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sha256 } from "./hash.mjs";
import { gitRead, SnapshotError, sha256File } from "./snapshot.mjs";

// Item name of the hooks path setting in a shared Git state diff.
const HOOKS_PATH_ITEM = "core.hooksPath";

/**
 * Reads the Git state that every work tree of a repository shares and that a turn can change from
 * a linked work tree: `core.hooksPath`, the hook files in the common `hooks/` directory, and the
 * configured remotes. `core.hooksPath` and the remotes come from the local and the worktree scope
 * on their own: the effective value of `core.hooksPath` would hide a change to the scope that the
 * other one overrides. The result holds digests only, so a config value or a URL never leaves this
 * function. An unexpected `git` exit throws a `SnapshotError`, because an empty state would read as
 * a change. The read starts two `git` processes at once, because every worker turn reads twice and
 * a process start is slow on Windows. `bound` takes `signal` and `timeoutMs`, as for `snapshot`.
 * @returns {Promise<{ hooksPath: string, hooks: Record<string, string | null>, remotes: Record<string, string> }>}
 */
export async function readSharedGit(cwd, bound) {
  const read = (args) => gitRead(cwd, args, { ...bound, allowExit: [0], createError: readFailure });
  const [commonResult, listResult] = await Promise.all([
    read(["rev-parse", "--git-common-dir"]),
    read(["config", "-z", "--list", "--show-scope"]),
  ]);
  const commonDir = commonResult.stdout.trim();
  const commonPath = isAbsolute(commonDir) ? commonDir : join(cwd, commonDir);
  const { hooksPath, remotes } = readConfigState(listResult.stdout);

  return { hooksPath, hooks: await readHooks(join(commonPath, "hooks")), remotes };
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
// value has no LF. Git writes the variable name in lower case.
function readConfigState(listing) {
  const hooksPath = { local: [], worktree: [] };
  const remotes = new Map();
  const tokens = listing.split("\0");
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i];
    if (scope !== "local" && scope !== "worktree") continue;
    const entry = tokens[i + 1];
    const newline = entry.indexOf("\n");
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? null : entry.slice(newline + 1);
    if (key === "core.hookspath") {
      hooksPath[scope].push(value);
    } else if (key.startsWith("remote.")) {
      const name = key.slice("remote.".length, key.lastIndexOf("."));
      remotes.set(name, [...(remotes.get(name) ?? []), [scope, entry]]);
    }
  }
  return {
    hooksPath: sha256(JSON.stringify(hooksPath)),
    remotes: Object.fromEntries(
      // The list keeps git's order: the first URL of a remote is the one `git remote get-url` returns.
      [...remotes].map(([name, list]) => [name, sha256(JSON.stringify(list))]),
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

// A `.sample` file is the template `git init` writes, never an active hook.
async function readHooks(hooksDir) {
  let names;
  try {
    names = await readdir(hooksDir);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return {};
    throw hookFailure("the hooks directory read", err);
  }
  const hooks = {};
  for (const name of names.filter((n) => !n.endsWith(".sample")).sort()) {
    try {
      hooks[name] = await sha256File(join(hooksDir, name));
    } catch (err) {
      throw hookFailure("a hook file read", err);
    }
  }
  return hooks;
}

/**
 * Names the shared Git items that differ between two `readSharedGit` results: `core.hooksPath`,
 * `hooks/<file>`, and `remote.<name>`. Never a value. Returns a sorted list, empty when none changed.
 */
export function diffSharedGit(before, after) {
  const changed = [];
  if (before.hooksPath !== after.hooksPath) changed.push(HOOKS_PATH_ITEM);
  for (const name of differing(before.hooks, after.hooks)) changed.push(`hooks/${name}`);
  for (const name of differing(before.remotes, after.remotes)) changed.push(`remote.${name}`);
  return changed.sort();
}

function differing(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
}
