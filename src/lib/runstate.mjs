// Lifecycle state file shared by the role subcommand (#55) and the parent
// guard hook (#57). The state file lives at a fixed path derived from the
// resolved work tree cwd, never passed as a flag; tests override the runs
// root with AGENT_LOOP_RUNS_ROOT.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { logWarn } from "./log.mjs";

export const TERMINAL_LIFECYCLES = new Set(["halted", "finished", "aborted"]);

/**
 * Resolve the state paths for one run. `cwd` derives the per-work-tree state
 * directory; `parentSession` derives the session index entry that the #57 hook
 * reads back. Both are optional so a caller with only one of them still
 * resolves the half it needs.
 * @param {{ cwd?: string, parentSession?: string }} args
 * @returns {{ root: string, stateDir?: string, stateFile?: string, lockFile?: string, sessionIndexFile?: string }}
 */
export function statePaths({ cwd, parentSession } = {}) {
  const root = stateRoot();
  const paths = { root };

  if (cwd !== undefined) {
    const stateDir = join(root, cwdHash(cwd));
    paths.stateDir = stateDir;
    paths.stateFile = join(stateDir, "state.json");
    paths.lockFile = join(stateDir, "state.lock");
  }

  if (parentSession !== undefined) {
    assertSessionId(parentSession);
    paths.sessionIndexFile = join(root, "sessions", parentSession);
  }

  return paths;
}

function stateRoot() {
  const override = process.env.AGENT_LOOP_RUNS_ROOT;
  return override ? resolve(override) : join(tmpdir(), "agent-loops", "runs");
}

function cwdHash(cwd) {
  return createHash("sha256").update(canonicalCwd(cwd)).digest("hex").slice(0, 12);
}

function canonicalCwd(cwd) {
  const resolved = resolve(cwd);
  // Windows drive letters compare case-insensitively in the filesystem but
  // not in the hash; normalize the letter so `c:\repo` and `C:\repo` share one
  // state directory.
  return resolved.replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
}

function assertSessionId(sessionId) {
  if (!sessionId || /[\\/\0]/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId ?? null)}`);
  }
}

/**
 * Reads the state file that the init call registered for a parent session id.
 * Returns null when the session has no index entry or the file is unreadable
 * as JSON; never throws on absence, so the #57 hook can treat it as unguarded.
 */
export async function readStateForSession(parentSession) {
  const indexFile = statePaths({ parentSession }).sessionIndexFile;
  let stateFile;
  try {
    stateFile = (await readFile(indexFile, "utf8")).trim();
  } catch {
    return null;
  }
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Exclusive access around one state-file operation. Creates `state.lock` with
 * O_EXCL, treats an existing lock with a live owner pid as busy and a dead one
 * as stale (removed with a warning, then retried). Returns a release function.
 */
export async function withStateLock(lockFile, fn) {
  await mkdir(dirname(lockFile), { recursive: true });
  await acquireLock(lockFile);
  try {
    return await fn();
  } finally {
    await rm(lockFile, { force: true });
  }
}

async function acquireLock(lockFile, retry = true) {
  try {
    const handle = await open(lockFile, "wx");
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        "utf8",
      );
    } finally {
      await handle.close();
    }
    return;
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }

  const owner = await readLockOwner(lockFile);
  if (owner && pidAlive(owner.pid)) {
    throw new Error(
      `State is locked by a live process (pid ${owner.pid}, started ${owner.startedAt ?? "unknown"}).`,
    );
  }

  if (!retry) {
    throw new Error("State lock could not be acquired after stale removal.");
  }

  logWarn(`removing stale state lock (dead pid ${owner?.pid ?? "unknown"})`);
  await rm(lockFile, { force: true });
  return acquireLock(lockFile, false);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function readLockOwner(lockFile) {
  try {
    return JSON.parse(await readFile(lockFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads and parses the state file. Returns null when absent; a corrupt file
 * throws so the caller exits instead of guessing the lifecycle.
 */
export async function readState(stateFile) {
  let text;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`State file is not a JSON object: ${stateFile}`);
  }
  return value;
}

export async function writeState(stateFile, state) {
  const temp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // Node rename replaces an existing destination on Windows and POSIX.
  await rename(temp, stateFile);
}

export async function appendSessionIndex(sessionIndexFile, stateFile) {
  // The index entry is overwritten by the next init call from the same session.
  await mkdir(dirname(sessionIndexFile), { recursive: true });
  return writeFile(sessionIndexFile, `${stateFile}\n`, "utf8");
}
