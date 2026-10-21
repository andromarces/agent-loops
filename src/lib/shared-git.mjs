import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { sha256 } from "./hash.mjs";
import { gitRead, SnapshotError, sha256File } from "./snapshot.mjs";

// Item name of the hooks path setting in a shared Git state diff.
const HOOKS_PATH_ITEM = "core.hooksPath";

/**
 * Reads the Git state that every work tree of a repository shares and that a turn can change from
 * a linked work tree: `core.hooksPath`, the hook files in the common `hooks/` directory, and the
 * configured remotes. The result holds digests only, so a config value or a URL never leaves this
 * function. `bound` takes `signal` and `timeoutMs`, as for `snapshot`.
 * @returns {Promise<{ hooksPath: string | null, hooks: Record<string, string | null>, remotes: Record<string, string> }>}
 */
export async function readSharedGit(cwd, bound) {
  const commonResult = await gitRead(cwd, ["rev-parse", "--git-common-dir"], bound);
  if (commonResult.exitCode !== 0) {
    throw new SnapshotError(`the shared Git directory could not be read: ${cwd}`);
  }
  const commonDir = commonResult.stdout.trim();
  const commonPath = isAbsolute(commonDir) ? commonDir : join(cwd, commonDir);

  // Exit 1 means the key is unset.
  const hooksResult = await gitRead(cwd, ["config", "--get", HOOKS_PATH_ITEM], bound);
  const hooksPath = hooksResult.exitCode === 0 ? sha256(hooksResult.stdout) : null;

  return {
    hooksPath,
    hooks: await readHooks(join(commonPath, "hooks")),
    remotes: await readRemotes(cwd, bound),
  };
}

// A `.sample` file is the template `git init` writes, never an active hook.
async function readHooks(hooksDir) {
  let names;
  try {
    names = await readdir(hooksDir);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return {};
    throw new SnapshotError(`the hooks directory could not be read: ${err.code ?? err.message}`, {
      cause: err,
    });
  }
  const hooks = {};
  for (const name of names.filter((n) => !n.endsWith(".sample")).sort()) {
    hooks[name] = await sha256File(join(hooksDir, name));
  }
  return hooks;
}

// One digest per remote name over all its `remote.<name>.*` entries.
async function readRemotes(cwd, bound) {
  const result = await gitRead(cwd, ["config", "-z", "--get-regexp", "^remote\\."], bound);
  // Exit 1 means no remote entry.
  if (result.exitCode !== 0) return {};
  const entries = new Map();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const name = key.slice("remote.".length, key.lastIndexOf("."));
    entries.set(name, [...(entries.get(name) ?? []), record]);
  }
  return Object.fromEntries(
    [...entries]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([n, list]) => [n, sha256(list.sort().join("\0"))]),
  );
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
