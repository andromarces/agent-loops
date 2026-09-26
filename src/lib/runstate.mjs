// Lifecycle state file shared by the role subcommand (#55) and the parent
// guard hook (#57). The state file lives at a fixed path derived from the
// resolved work tree cwd, never passed as a flag; tests override the runs
// root with AGENT_LOOP_RUNS_ROOT.
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { logWarn } from "./log.mjs";

export const TERMINAL_LIFECYCLES = new Set(["halted", "finished", "aborted"]);

// An unparseable lock younger than this is never treated as stale: a fresh
// unreadable lock is a contender racing a removal, a foreign file, or (on the
// exclusive-create fallback path) a half-written owner.
export const STALE_LOCK_GRACE_MS = 60_000;

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

// A parent session id is one path segment under <root>/sessions and is matched
// verbatim against the harness session id by the #57 guard. Real harness ids
// are opaque tokens, but an unexpanded template (`${CLAUDE_SESSION_ID}`,
// `%CODEX_THREAD_ID%`, `<parent-session-id>`), a path separator, or whitespace
// can only come from a caller that failed to expand its placeholder. Any of
// them would register a run whose parent never matches, so refuse all of them
// before a state file exists. A bare placeholder name with no punctuation
// (`CLAUDE_SESSION_ID`) is indistinguishable from a real token here; only a
// harness-id allowlist would catch it, which ADR 0006 rejects.
const SESSION_ID_FORBIDDEN = /[\\/\0\s$`{}%<>]/;

function assertSessionId(sessionId) {
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    SESSION_ID_FORBIDDEN.test(sessionId)
  ) {
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
 * Exclusive access around one state-file operation. Creates `state.lock`
 * atomically (a hard link, or an exclusive create where the filesystem has no
 * link support), treats an existing lock with a live owner pid as busy and a
 * dead one as stale (removed with a warning, then retried). Returns the result
 * of `fn`.
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

// Monotonic suffix for lock temp files; keeps same-process contenders that
// share a pid on distinct paths so one's cleanup never removes another's.
let lockTempCounter = 0;

// `link` is the atomic create primitive, but FAT/exFAT and some network mounts
// have no hard links and report one of these codes. They fall back to an
// exclusive create, where the pre-#176 create/write window returns.
const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "ENOSYS",
  "EMLINK",
  "EXDEV",
]);

// Matches the `<pid>.<counter>.tmp` suffix of a lock temp file name.
const LOCK_TEMP_SUFFIX = /^(\d+)\.\d+\.tmp$/;

async function acquireLock(lockFile, retry = true) {
  if (await createLock(lockFile)) {
    // Best-effort removal of temp files left by a crash between the temp write
    // and the link (#178). Runs while the lock is held and never touches a live
    // contender's temp, so it cannot break a racing acquisition.
    await pruneStaleLockTemps(lockFile);
    return;
  }

  const owner = await readLockOwner(lockFile);
  if (owner && pidAlive(owner.pid)) {
    throw new Error(
      `State is locked by a live process (pid ${owner.pid}, started ${owner.startedAt ?? "unknown"}).`,
    );
  }

  if (!owner && (await lockAgeMs(lockFile)) < STALE_LOCK_GRACE_MS) {
    // Unparseable and fresh: fail closed. On a link-capable filesystem creation
    // is atomic, so this is a removal race (lockAgeMs reads 0 on ENOENT) or a
    // foreign file; the exclusive-create fallback can leave a half-written
    // owner, which this refusal also covers.
    throw new Error("State is locked (the lock file is not readable yet; retry shortly).");
  }

  if (!retry) {
    throw new Error("State lock could not be acquired after stale removal.");
  }

  logWarn(`removing stale state lock (dead pid ${owner?.pid ?? "unknown"})`);
  await rm(lockFile, { force: true });
  return acquireLock(lockFile, false);
}

// Create the lock and its owner content. The owner JSON goes to a private temp
// file that is hard linked to the lock path; the link is atomic, so EEXIST
// means a contender won and the owner is readable the instant the lock exists
// (fixes #176 path 1). On a filesystem with no hard links, an exclusive create
// and write keeps the lock usable at the cost of that window. Returns false
// only when another owner already holds the lock.
async function createLock(lockFile) {
  const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const tempFile = `${lockFile}.${process.pid}.${lockTempCounter++}.tmp`;
  await writeFile(tempFile, owner, "utf8");
  try {
    await link(tempFile, lockFile);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") {
      return false;
    }
    if (!LINK_UNSUPPORTED.has(err.code)) {
      throw err;
    }
    try {
      await writeFile(lockFile, owner, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (openErr) {
      if (openErr.code === "EEXIST") {
        return false;
      }
      throw openErr;
    }
  } finally {
    await rm(tempFile, { force: true });
  }
}

// Removes lock temp files whose creating pid is gone. A live contender's temp
// is never touched, so a concurrent acquisition is unaffected; failures are
// ignored because cleanup is best-effort and must not fail the lock holder.
async function pruneStaleLockTemps(lockFile) {
  try {
    const dir = dirname(lockFile);
    const prefix = `${basename(lockFile)}.`;
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const match = LOCK_TEMP_SUFFIX.exec(entry.slice(prefix.length));
      if (match === null) {
        continue;
      }
      const pid = Number(match[1]);
      if (pid === process.pid || pidAlive(pid)) {
        continue;
      }
      await rm(join(dir, entry), { force: true });
    }
  } catch {
    // The lock is already held; a failed scan or unlink leaves only a temp file.
  }
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
    const value = JSON.parse(await readFile(lockFile, "utf8"));
    if (value === null || typeof value !== "object" || !Number.isInteger(value.pid)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function lockAgeMs(lockFile) {
  try {
    const stats = await stat(lockFile);
    return Date.now() - stats.mtimeMs;
  } catch {
    return 0;
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

export async function writeSessionIndex(sessionIndexFile, stateFile) {
  // The index entry is overwritten by the next init call from the same session.
  await mkdir(dirname(sessionIndexFile), { recursive: true });
  return writeFile(sessionIndexFile, `${stateFile}\n`, "utf8");
}
