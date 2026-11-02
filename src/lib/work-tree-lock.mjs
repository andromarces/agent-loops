// Git work tree lock for an active run (issue #1347, ADR 0073). Init locks a linked `--cwd`, and a
// terminal lifecycle unlocks it. Every failure is a warning: the lock is a protection, not a
// precondition of the command that takes or drops it.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { logInfo, logWarn } from "./log.mjs";
import { gitRead } from "./snapshot.mjs";

// Milliseconds that one `git` read waits before it ends the child.
const GIT_READ_TIMEOUT_MS = 60_000;

/** The Git lock reason of one run, as the removal step and a maintainer read it. */
export const workTreeLockReason = (runId) => `agent-loop run ${runId} active`;

const stripLf = (text) => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** Runs one `git` read and returns its stdout; any other exit code is an error. */
async function readOutput(cwd, args, readGit, signal) {
  const result = await readGit(cwd, args, {
    signal,
    timeoutMs: GIT_READ_TIMEOUT_MS,
    stripFinalNewline: false,
  });
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(`git ${args[0]} failed`), {
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}

/**
 * Parses `git worktree list --porcelain -z` into `{ path, locked, reason }` records. Git prints
 * `locked <reason>` as one NUL-ended field and `locked` alone for a lock with no reason.
 */
function parseEntries(stdout) {
  const entries = [];
  let current = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      current = null;
    } else if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), locked: false, reason: null };
      entries.push(current);
    } else if (current === null) {
      continue;
    } else if (field === "locked") {
      current.locked = true;
    } else if (field.startsWith("locked ")) {
      current.locked = true;
      current.reason = field.slice(7);
    }
  }
  return entries;
}

/** Compares two paths canonically, so a symlinked or short path names its own work tree. */
async function samePath(left, right) {
  const canon = async (path) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  const [first, second] = await Promise.all([canon(left), canon(right)]);
  return first === second;
}

/**
 * Resolves the work tree root of `cwd` and its record in `git worktree list`, which holds the
 * lock state. `main` is true for the main work tree, which Git refuses to lock.
 */
async function locate(cwd, readGit, signal) {
  const root = stripLf(await readOutput(cwd, ["rev-parse", "--show-toplevel"], readGit, signal));
  if (root === "") {
    throw new Error("cwd has no work tree root");
  }
  const entries = parseEntries(
    await readOutput(cwd, ["worktree", "list", "--porcelain", "-z"], readGit, signal),
  );
  let own = null;
  for (const candidate of entries) {
    if (await samePath(candidate.path, root)) {
      own = candidate;
      break;
    }
  }
  return {
    root,
    main: entries.length > 0 && (await samePath(entries[0].path, root)),
    locked: own?.locked === true,
    reason: own?.reason ?? null,
  };
}

/** Runs one lock operation and turns every failure into a warning and a `failed` result. */
async function attempt(label, runId, operation) {
  try {
    return await operation();
  } catch (err) {
    logWarn(
      `work tree lock: ${label} failed for run ${runId} (${err.exitCode ?? err.code ?? "error"})`,
    );
    return { status: "failed" };
  }
}

/**
 * Locks the work tree that holds `cwd` for `runId`, when that work tree is linked. The main work
 * tree cannot be locked, so it is skipped with a log line. A lock that is already present belongs
 * to another owner and is kept, whatever its reason. Returns `{ status, root }`; a failure warns
 * and returns `status: "failed"`, never a throw.
 * `read` is a test seam for the `git` reader.
 */
export function lockWorkTree(cwd, { runId, signal, read: readGit = gitRead } = {}) {
  return attempt("the lock", runId, async () => {
    const tree = await locate(cwd, readGit, signal);
    if (tree.main) {
      logInfo("work tree lock: the main work tree cannot be locked, so this run holds no lock");
      return { status: "skipped", root: tree.root };
    }
    if (tree.locked) {
      logInfo(
        `work tree lock: the work tree is already locked, so the existing lock is kept: ${tree.root}`,
      );
      return { status: "kept", root: tree.root };
    }
    await readOutput(
      cwd,
      ["worktree", "lock", "--reason", workTreeLockReason(runId), tree.root],
      readGit,
      signal,
    );
    logInfo(`work tree lock: locked ${tree.root} for run ${runId}`);
    return { status: "locked", root: tree.root };
  });
}

/**
 * Unlocks the work tree that holds `cwd`, but only when its lock reason names `runId`. A work tree
 * that another process removed and re-created at the path holds no such lock, so it is left alone.
 * Returns `{ status, root }`; a failure warns and returns `status: "failed"`, never a throw.
 * `read` is a test seam for the `git` reader.
 */
export function unlockWorkTree(cwd, { runId, signal, read: readGit = gitRead } = {}) {
  return attempt("the unlock", runId, async () => {
    const tree = await locate(cwd, readGit, signal);
    if (!tree.locked) {
      return { status: "unchanged", root: tree.root };
    }
    if (tree.reason !== workTreeLockReason(runId)) {
      logInfo(`work tree lock: the lock of ${tree.root} does not name run ${runId}, so it is kept`);
      return { status: "kept", root: tree.root };
    }
    await readOutput(cwd, ["worktree", "unlock", tree.root], readGit, signal);
    logInfo(`work tree lock: unlocked ${tree.root} for run ${runId}`);
    return { status: "unlocked", root: tree.root };
  });
}
