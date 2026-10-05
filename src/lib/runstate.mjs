// Lifecycle state file shared by the role subcommand (#55) and the parent
// guard hook (#57). The state file lives at a fixed path derived from the
// resolved work tree cwd, never passed as a flag; tests override the runs
// root with AGENT_LOOP_RUNS_ROOT.
//
// One parent session can drive several concurrent runs, one per work tree. Init
// registers each run as its own entry file at
// `<root>/session-runs/<parent-session>/<cwd hash>` (the state directory name),
// so simultaneous inits in different work trees never overwrite each other. The
// guard reads every entry under that directory and denies if any resolves to a
// non-terminal run owned by the hook session. The reader also unions the legacy
// single-file index at `<root>/sessions/<parent-session>`; init never writes it,
// and the directory name avoids a file-versus-directory clash at that path.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isJsonObject } from "./json.mjs";
import { logWarn } from "./log.mjs";

export const TERMINAL_LIFECYCLES = new Set(["halted", "finished", "aborted"]);

// An unparseable lock younger than this is never treated as stale: a fresh
// unreadable lock is a contender racing a removal, a foreign file, or (on the
// exclusive-create fallback path) a half-written owner.
export const STALE_LOCK_GRACE_MS = 60_000;

/**
 * Resolve the state paths for one run. `cwd` derives the per-work-tree state
 * directory; `parentSession` derives the session-run entry directory and the
 * legacy index file that the #57 hook reads back. Both are optional so a caller
 * with only one of them still resolves the half it needs. `sessionEntryFile` is
 * present only when both are given.
 * @param {{ cwd?: string, parentSession?: string }} args
 * @returns {{ root: string, stateDir?: string, stateFile?: string, lockFile?: string, sessionEntryFile?: string, sessionRunsDir?: string, legacyIndexFile?: string }}
 */
export function statePaths({ cwd, parentSession } = {}) {
  const root = stateRoot();
  const paths = { root };

  if (parentSession !== undefined) {
    assertSessionId(parentSession);
  }

  if (cwd !== undefined) {
    const stateDirName = cwdHash(cwd);
    const stateDir = join(root, stateDirName);
    paths.stateDir = stateDir;
    paths.stateFile = join(stateDir, "state.json");
    paths.lockFile = join(stateDir, "state.lock");
    if (parentSession !== undefined) {
      paths.sessionEntryFile = join(root, "session-runs", parentSession, stateDirName);
    }
  }

  if (parentSession !== undefined) {
    paths.sessionRunsDir = join(root, "session-runs", parentSession);
    paths.legacyIndexFile = join(root, "sessions", parentSession);
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

// A parent session id is one path segment under <root>/session-runs and under
// the legacy <root>/sessions, and is matched verbatim against the harness
// session id by the #57 guard. Real harness ids
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
 * Reads every state file registered by a parent session id and returns the
 * parsed states that are readable. Unions the per-run entry directory with the
 * legacy single-path index. A missing, unreadable, or corrupt entry or state
 * file is skipped, never thrown: the #57 hook treats an empty list as
 * unguarded, and one corrupt run never hides another active run.
 * @returns {Promise<object[]>}
 */
export async function readStatesForSession(parentSession) {
  const { sessionRunsDir, legacyIndexFile } = statePaths({ parentSession });
  const stateFiles = await readSessionEntryPaths(sessionRunsDir, legacyIndexFile);
  const states = [];
  for (const stateFile of stateFiles) {
    try {
      states.push(JSON.parse(await readFile(stateFile, "utf8")));
    } catch {
      // Skip an unreadable or corrupt state file; it never denies on its own.
    }
  }
  return states;
}

// Collects the state file path from every entry file in the new directory and
// from the legacy single-path index. An entry that cannot be read is skipped,
// and a temp file left by an interrupted atomic write is not an entry.
async function readSessionEntryPaths(sessionRunsDir, legacyIndexFile) {
  const stateFiles = [];
  try {
    for (const name of await readdir(sessionRunsDir)) {
      if (name.endsWith(".tmp")) {
        continue;
      }
      try {
        stateFiles.push((await readFile(join(sessionRunsDir, name), "utf8")).trim());
      } catch {
        // Skip an unreadable entry.
      }
    }
  } catch {
    // No entry directory: every run predates the new format or none registered.
  }
  try {
    stateFiles.push((await readFile(legacyIndexFile, "utf8")).trim());
  } catch {
    // No legacy entry.
  }
  return stateFiles.filter((stateFile) => stateFile !== "");
}

/**
 * Exclusive access around one state-file operation. Creates `state.lock` (an
 * atomic hard link where supported, otherwise an exclusive create), treats an
 * existing lock with a live owner pid as busy and a dead one as stale
 * (removed with a warning, then retried once). The removal runs under a claim
 * file `<lock>.reap.<digest>` keyed by the stale content (a fixed-length name at
 * every depth), so at most one contender removes it. It deletes the lock only if the lock still holds the content read
 * as stale. Each acquisition writes a unique nonce, so a lock that a new owner
 * created in between never matches and survives, and the retry reports it as
 * busy. This guarantee holds only when every contender runs this version or
 * later: a contender on an older version removes a stale lock with a bare rm and
 * keeps the original race with any other contender. A lock written without a
 * nonce by an older version is matched by content alone, so an older-version
 * owner with the same pid and start time in the same millisecond is taken for
 * it. A contender that finds a live claim exits as busy. A claim
 * left by a crashed process is removed the same way, under a claim keyed by its
 * own content when a contender meets the stale lock it guards. A later
 * acquisition of the lock also removes a claim with a dead pid when it creates
 * the guard claim itself, and leaves the claim if that guard already exists
 * (#377). Returns the result of `fn`. `label`
 * names the guarded resource in a refusal, so an installer refusal can say what
 * is locked instead of the generic default; `noun` is the same resource as a
 * lowercase phrase for the stale-removal warning.
 */
export async function withStateLock(lockFile, fn, { label = "State", noun = "state" } = {}) {
  await mkdir(dirname(lockFile), { recursive: true });
  await acquireLock(lockFile, { label, noun });
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
// EISDIR is the Windows mapping: libuv translates the ERROR_INVALID_FUNCTION
// from CreateHardLinkW on FAT/exFAT to EISDIR (nodejs/node#65817).
const LINK_UNSUPPORTED = new Set([
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "ENOSYS",
  "EMLINK",
  "EXDEV",
  "EISDIR",
]);

// Nesting bound for dead stale-removal claims; a deeper chain fails closed.
const MAX_CLAIM_DEPTH = 3;

// Matches the `<pid>.<counter>.tmp` suffix of a lock temp file name.
const LOCK_TEMP_SUFFIX = /^(\d+)\.\d+\.tmp$/;

// Matches the `.reap.<digest>` suffix of a claim file name (see claimFileFor).
const CLAIM_SUFFIX = /^\.reap\.[0-9a-f]{64}$/;

async function acquireLock(
  lockFile,
  { retry = true, label = "State", noun = "state", depth = 0, rootLockFile = lockFile } = {},
) {
  if (await createLock(lockFile)) {
    // Best-effort removal of temp files left by a crash between the temp write
    // and the link (#178). Runs while the lock is held and never touches a live
    // contender's temp, so it cannot break a racing acquisition.
    await pruneStaleLockTemps(lockFile);
    if (depth === 0) {
      await pruneDeadClaims(lockFile);
    }
    return;
  }

  const lockText = await readLockText(lockFile);
  const owner = parseLockOwner(lockText);
  if (owner && pidAlive(owner.pid)) {
    throw new Error(
      `${label} is locked by a live process (pid ${owner.pid}, started ${owner.startedAt ?? "unknown"}).`,
    );
  }

  if (!owner && (await lockAgeMs(lockFile)) < STALE_LOCK_GRACE_MS) {
    // Unparseable and fresh: fail closed. On a link-capable filesystem creation
    // is atomic, so this is a removal race (lockAgeMs reads 0 on ENOENT) or a
    // foreign file; the exclusive-create fallback can leave a half-written
    // owner, which this refusal also covers.
    throw new Error(`${label} is locked (the lock file is not readable yet; retry shortly).`);
  }

  if (!retry) {
    throw new Error(`${label} lock could not be acquired after stale removal.`);
  }

  if (depth >= MAX_CLAIM_DEPTH) {
    throw new Error(
      `${label} is locked (stale-removal claims from crashed processes are nested too deep).`,
    );
  }

  logWarn(`removing stale ${noun} lock (dead pid ${owner?.pid ?? "unknown"})`);
  await removeStaleFile(lockFile, lockText, { label, depth, rootLockFile });
  return acquireLock(lockFile, { retry: false, label, noun, depth, rootLockFile });
}

// Path of the claim that guards the removal of the file that holds `staleText`.
// The name is `<root lock name>.reap.<digest>` beside the lock, so it has the same
// length at every nesting depth, which keeps a recovery chain within the Windows
// path limit. The digest is the full SHA-256 of the guarded file's name and its
// JSON-encoded content: distinct inputs get distinct names up to SHA-256
// collision resistance, not by a strict injective mapping, and a claim for a
// claim differs from a first-level claim because the guarded name differs. The
// JSON encoding keeps an unreadable file (null) and the literal text "null"
// apart.
function claimFileFor(rootLockFile, file, staleText) {
  const id = createHash("sha256")
    .update(JSON.stringify([basename(file), staleText]))
    .digest("hex");
  return `${rootLockFile}.reap.${id}`;
}

// A claim guards the removal of one stale file, and a dead claim is itself
// removed under a claim keyed by its own content. Each level's claim is created
// with the exclusive link, so exactly one contender wins it, and it is removed
// only by its winner. While a winner holds it, the stale file cannot change: its
// owner is dead, nobody else removes it, and nobody creates a file at a path
// that exists. Every acquisition writes unique content (a nonce), so a file that
// reads as the stale content under the claim is the file that was read as stale,
// and removing it cannot delete a new owner's file (#363). Nothing is renamed, and no path is bare-removed unclaimed. A loser
// finds a live claim and exits as busy; a file that reads differently or cannot
// be read is kept, and the caller's retry reports it as busy.
// known-limit: a chain of more than two crashed claims fails closed
// (MAX_CLAIM_DEPTH). The acquisition scan (pruneDeadClaims) never removes an
// unparseable claim or a claim whose guard claim already exists, so an orphan
// claim in either state stays until a contender meets the stale lock it guards. A lock written without a nonce by an older version is
// matched by content alone, so an older-version owner with the same pid and
// start time in the same millisecond would be taken for it.
// Mixed versions: a contender that runs an older version removes a stale lock
// with a bare rm, so it can still remove a new live lock exactly as before this
// fix. The guarantee holds only when every contender runs this version or later.
async function removeStaleFile(file, staleText, { label, depth, rootLockFile }) {
  const claimFile = claimFileFor(rootLockFile, file, staleText);
  await acquireLock(claimFile, {
    label,
    noun: "stale-removal claim",
    depth: depth + 1,
    rootLockFile,
  });
  try {
    if (await stillStale(file, staleText)) {
      await rm(file, { force: true });
    }
  } finally {
    await rm(claimFile, { force: true });
  }
}

// True when the lock still holds the content read as stale. An unparseable
// lock must also still be older than the grace window.
async function stillStale(lockFile, staleText) {
  if ((await readLockText(lockFile)) !== staleText) {
    return false;
  }
  return parseLockOwner(staleText) !== null || (await lockAgeMs(lockFile)) >= STALE_LOCK_GRACE_MS;
}

// Create the lock and its owner content. The owner JSON goes to a private temp
// file that is hard linked to the lock path; the link is atomic, so EEXIST
// means a contender won and the owner is readable the instant the lock exists
// (fixes #176 path 1). On a filesystem with no hard links, an exclusive create
// and write keeps the lock usable at the cost of that window. Returns false
// only when another owner already holds the lock.
async function createLock(lockFile) {
  // The nonce makes every acquisition's content unique, so a re-read that matches
  // the stale content can only be the same file, never a later owner (#363). A
  // lock written without one by an older version parses the same way.
  const owner = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    nonce: randomUUID(),
  });
  const tempFile = `${lockFile}.${process.pid}.${lockTempCounter++}.tmp`;
  // The write is inside the guard because it creates the temp file: a write cut
  // short leaves a partial temp behind, and the prune never removes a temp owned
  // by the running process, so nothing else would clean it (#353).
  try {
    await writeFile(tempFile, owner, "utf8");
    const created = await linkLock(tempFile, lockFile, owner);
    await removeTemp(tempFile);
    return created;
  } catch (err) {
    // The body already failed, so a temp that will not delete is the lesser
    // problem: swallow the cleanup error and surface the one the caller must
    // act on (#353).
    await removeTemp(tempFile);
    throw err;
  }
}

async function linkLock(tempFile, lockFile, owner) {
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

// Removes claim files whose owner is dead, so a claim left by a crashed process
// does not wait for a contender to meet the same stale lock (#377). Runs while
// the root lock is held, so no stale lock is left to guard. A claim is removed
// only when it parses to a dead pid and the guard claim keyed by its own content
// (the one a takeover contender takes, see claimFileFor) is created fresh by
// this call. An existing guard is never taken over here: a guard that is live,
// dead, or unfinished (created but not yet filled) is left in place, because
// this scan cannot tell an unfinished live guard from a dead one. The pass
// repeats while it removes a claim, so a chain of dead claims clears from the
// guard end. Failures are ignored because cleanup is best-effort and must not
// fail the lock holder.
async function pruneDeadClaims(lockFile) {
  try {
    const dir = dirname(lockFile);
    const name = basename(lockFile);
    let removed = true;
    while (removed) {
      removed = false;
      for (const entry of await readdir(dir)) {
        if (!entry.startsWith(name) || !CLAIM_SUFFIX.test(entry.slice(name.length))) {
          continue;
        }
        removed = (await removeDeadClaim(join(dir, entry), lockFile)) || removed;
      }
    }
  } catch {
    // The lock is already held; a failed scan leaves only a claim file.
  }
}

async function removeDeadClaim(claimFile, rootLockFile) {
  const claimText = await readLockText(claimFile);
  const owner = parseLockOwner(claimText);
  if (owner === null || pidAlive(owner.pid)) {
    return false;
  }
  const guardFile = claimFileFor(rootLockFile, claimFile, claimText);
  try {
    if (!(await createLock(guardFile))) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    // The guard blocks every takeover of this claim, so a read that still
    // matches is the claim that was read as dead (nonce, see createLock).
    if ((await readLockText(claimFile)) !== claimText) {
      return false;
    }
    logWarn(`removing orphan claim file (dead pid ${owner.pid})`);
    await rm(claimFile, { force: true });
    return true;
  } finally {
    await rm(guardFile, { force: true });
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

// Raw lock content, or null when the lock cannot be read.
async function readLockText(lockFile) {
  try {
    return await readFile(lockFile, "utf8");
  } catch {
    return null;
  }
}

function parseLockOwner(text) {
  try {
    const value = JSON.parse(text);
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
  if (!isJsonObject(value)) {
    throw new Error(`State file is not a JSON object: ${stateFile}`);
  }
  return value;
}

export async function writeState(stateFile, state) {
  await writeFileAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// Monotonic suffix for state temp files, for the same reason as the lock temp
// counter: one pid writes several temps concurrently, and a cleanup must remove
// only the file its own call created (#353).
let stateTempCounter = 0;

// A transient unlink failure clears once the holder lets go, so a failed removal
// is retried once. A persistent failure is swallowed: this runs on the way out
// of an already-failed operation, and the leftover temp is a lesser problem than
// replacing the error the caller must act on (#353).
const UNLINK_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function removeTemp(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rm(path, { force: true });
    } catch (err) {
      if (!UNLINK_RETRY_CODES.has(err.code) || attempt >= 1) {
        return;
      }
      await delay(10);
    }
  }
}

// Writes `text` to `file` atomically: a private temp file in the same directory
// is renamed over the destination, so a concurrent reader sees the old content
// or the new content, never a partial write. Node rename replaces an existing
// destination on Windows and POSIX. A failed write or rename leaves the temp
// behind, and it sits in the state directory beside the lock temp, so the guard
// removes it and keeps the original error as the one that surfaces (#353).
export async function writeFileAtomic(file, text) {
  const temp = `${file}.${process.pid}.${stateTempCounter++}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await renameWithRetry(temp, file);
  } catch (err) {
    await removeTemp(temp);
    throw err;
  }
}

// Rename is the atomic replace step, but on Windows it fails while another
// process holds the destination open. EPERM is the observed code; EACCES and
// EBUSY join the retry set for the general Windows and network-mount failure
// set. A continuous reader can hold the destination past a fixed short delay,
// so the wait grows across attempts. The budget is about 400 ms, enough to
// outlast the observed hold while a real failure still surfaces quickly: the
// original error is rethrown once the schedule is spent (#233, #242).
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
// Wait before each retry, in order. Six attempts total wait 385 ms.
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Writes one run's entry under the parent session's entry directory. The entry
 * name is the state directory name, so a re-init in the same work tree
 * overwrites its own entry while a concurrent init in another work tree writes
 * a different file. The per-cwd state lock serializes the same-work-tree case,
 * and the atomic rename keeps a concurrent guard from reading a partial entry.
 */
export async function writeSessionEntry(entryFile, stateFile) {
  await mkdir(dirname(entryFile), { recursive: true });
  return writeFileAtomic(entryFile, `${stateFile}\n`);
}
