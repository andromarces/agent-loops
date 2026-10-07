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
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./hash.mjs";
import { isJsonObject } from "./json.mjs";
import { logWarn } from "./log.mjs";

export const TERMINAL_LIFECYCLES = new Set(["halted", "finished", "aborted"]);

// An unparseable lock or claim with no live marker (see `hasLiveWriter`) is
// stale only once it is older than this. A writer of an older version that runs
// the exclusive-create fallback leaves no marker, and its file cannot be told from
// a dead one by anything but age. A file with a live marker never expires.
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

/**
 * The name of the state directory of the run in one work tree, which is also the key that binds
 * a spawned child to its run (issue #392). It hashes the lexical path, so a path spelling that
 * the state lookup treats as another run is another key and finds no state.
 */
export function cwdHash(cwd) {
  return sha256(canonicalCwd(cwd)).slice(0, 12);
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
 * existing lock with a live owner (`ownerAlive`) as busy and a dead one as stale
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
 * own content, and each successful acquisition also removes the orphaned claims
 * beside the lock (see `ownerless`). Returns the result of `fn`. `label`
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

// Suffix for lock temp files (the writer marker of `hasLiveWriter`). The token is
// unique to this process and the counter to this call, so no two writers share a
// marker path: same-process contenders differ by counter, and a later process
// that reuses a pid differs by token, so a cleanup never removes a marker that it
// did not create.
const LOCK_TEMP_TOKEN = randomUUID().replaceAll("-", "");
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

// Matches the `<pid>.<token>.<counter>.tmp` suffix of a lock temp file name, with
// the `reap.<digest>.` part of a claim's name before it. Group 1 is the pid and
// group 2 the token. The token is absent from the `<pid>.<counter>.tmp` name that
// an older version writes; that name counts as a marker for liveness only.
const LOCK_TEMP_SUFFIX = /^(?:reap\.[0-9a-f]{64}\.)?(\d+)\.(?:([0-9a-f]{32})\.)?\d+\.tmp$/;

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
      await pruneOrphanClaims(lockFile, label);
    }
    return;
  }

  const lockText = await readLockText(lockFile);
  const owner = parseLockOwner(lockText);
  if (owner && (await ownerAlive(owner))) {
    throw new Error(
      `${label} is locked by a live process (pid ${owner.pid}, started ${owner.startedAt ?? "unknown"}).`,
    );
  }

  if (!owner && (lockText === null || !(await ownerless(lockFile)))) {
    // Fail closed when the owner cannot be identified: the file is missing
    // (a removal race) or cannot be read, or the exclusive-create fallback has
    // created it and its writer has not written the content yet (a live marker,
    // or a file younger than the grace window for a writer without a marker).
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
// JSON encoding keeps an empty text and the literal text "null" apart.
function claimFileFor(rootLockFile, file, staleText) {
  const id = sha256(JSON.stringify([basename(file), staleText]));
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
// A claim left by a crashed process is removed in two ways, both through this
// claimed removal: a contender that meets its stale file, and the scan that each
// lock acquisition runs (`pruneOrphanClaims`, #452). Both key the guard by the
// claim's name and content, so exactly one process acts on a claim. A file counts
// as dead only when `ownerAlive` reads its parsed owner as dead (its pid is dead, or
// its pid is alive but now belongs to another process, a reused pid; a valid
// `linux-proc` stamp of another PID namespace, or any valid `linux-proc` stamp while
// the reader namespace cannot be read, keeps the owner alive instead), or when it is
// unparseable and `ownerless` finds no live marker and an age past the grace window
// (ADR 0020).
// When each orphan is removed (ADR 0020), by the first lock acquisition that
// finds it, or by a contender that meets its stale file:
// - a parsed claim whose owner reads as dead (`ownerAlive`: a dead pid, or a reused
//   pid): at once. A claim with a valid `linux-proc` stamp of another PID namespace,
//   or with any valid `linux-proc` stamp while the reader cannot read its own PID
//   namespace, stays even when its pid is dead here.
// - an unparseable claim with no live marker: once it is older than
//   STALE_LOCK_GRACE_MS, so a fresh one stays until it has aged.
// - an unparseable claim with a live marker, a claim whose owner reads as alive (see
//   `ownerAlive`), and a file that cannot be read: never, while that stays true.
// known-limit: a lock or claim records a start-time stamp of the owner with its pid
// (`processStartTime`), and a live pid whose current stamp is valid, of the same kind
// (and Linux PID namespace), and differs reads as dead (a reused pid). Any other live
// pid reads as alive, so a reused pid keeps the file until that process exits: no
// recorded stamp (an older version, or an owner that could not read its own), a
// platform with no source, an invalid stamp (`parseStamp`), a kind mismatch, and a
// current read that failed, timed out (5 s), or did not parse. A valid `linux-proc`
// stamp of another PID namespace, or any valid `linux-proc` stamp while the reader
// cannot read its own PID namespace, reads as alive whatever its pid is here. The Linux stamp is
// clock independent. The macOS and Windows stamps are fixed at process
// creation and compared with a 2 s tolerance that covers only their one-second
// resolution, so a reuse within it reads as the owner. A marker file name carries only
// a pid, so `hasLiveWriter` stays pid-only. A chain of more than
// two crashed claims fails closed (MAX_CLAIM_DEPTH). A lock written without a nonce by an
// older version is matched by content alone, so an older-version owner with the
// same pid and start time in the same millisecond would be taken for it.
// known-limit: a writer of an older version that runs the exclusive-create
// fallback leaves no marker, so its unwritten file is kept only while it is
// younger than STALE_LOCK_GRACE_MS. A marker-less writer that stalls past the
// window loses the file; upgrading every agent-loop process removes the case.
// The `<pid>.<n>.tmp` marker of an older version is honored for liveness but
// never removed (see pruneStaleLockTemps), so one that a crashed older version
// left stays on disk.
// Mixed versions: a contender that runs an older version removes a stale lock
// with a bare rm, or takes an unwritten file over after its grace window, so it
// can still remove a new live lock exactly as before this fix. The guarantee
// holds only when every contender runs this version or later.
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

// True when the file still holds the content read as stale. A parsed owner's
// content is unique (nonce), so equal content is the same file. An unparseable
// file has no unique content, so it is stale only while the same file (same
// identity before and after the reads) has no owner.
async function stillStale(file, staleText) {
  if (parseLockOwner(staleText) !== null) {
    return (await readLockText(file)) === staleText;
  }
  const before = await fileStamp(file);
  if (before === null || !(await ownerless(file, before))) {
    return false;
  }
  return (
    (await readLockText(file)) === staleText &&
    (await fileStamp(file))?.identity === before.identity
  );
}

// Identity and age of a file, or null when it is missing. The identity tells a
// file apart from a later file at the same path, which the equal text of an
// unparseable file cannot.
async function fileStamp(file) {
  try {
    const stats = await stat(file, { bigint: true });
    return {
      identity: `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
      ageMs: Date.now() - Number(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}

// True when no writer can still own the unparseable `file`: no live marker, and
// the file is older than the grace window (the writer of an older version leaves
// no marker). `stamp` is a stamp already taken for the same read.
async function ownerless(file, stamp) {
  const current = stamp ?? (await fileStamp(file));
  return current !== null && current.ageMs >= STALE_LOCK_GRACE_MS && !(await hasLiveWriter(file));
}

// True when a running process may still be writing `file`. Before the content of
// a lock or claim exists (the exclusive-create fallback), the creator's temp
// file `<file>.<pid>.<token>.<n>.tmp` is the only trace of its owner: createLock
// writes it before it creates `file` and removes it after the content is written.
// A temp with a live pid therefore marks a file that must not be taken over, at
// any age. Pid reuse can only report a live writer, never a dead one for a live
// process, and the token keeps a reused pid's marker on its own path.
async function hasLiveWriter(file) {
  const prefix = `${basename(file)}.`;
  let entries;
  try {
    entries = await readdir(dirname(file));
  } catch {
    return true;
  }
  return entries.some((entry) => {
    const match = entry.startsWith(prefix) && LOCK_TEMP_SUFFIX.exec(entry.slice(prefix.length));
    return match && pidAlive(Number(match[1]));
  });
}

// Matches the name of a claim file beside the lock.
const CLAIM_SUFFIX = /^\.reap\.[0-9a-f]{64}$/;

// Removes the orphaned claims beside `lockFile`: a claim whose parsed pid is dead,
// or an unparseable one that no running writer can own. Runs while the lock is
// held, through the same claimed removal as a takeover, so one process acts on
// each claim. A claim that is live, busy, or unreadable is kept. Best-effort: a
// failure leaves the claim for the next acquisition and never fails the holder.
async function pruneOrphanClaims(lockFile, label) {
  try {
    const dir = dirname(lockFile);
    const prefix = basename(lockFile);
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix) || !CLAIM_SUFFIX.test(entry.slice(prefix.length))) {
        continue;
      }
      const claimFile = join(dir, entry);
      try {
        const text = await readLockText(claimFile);
        const owner = parseLockOwner(text);
        const orphaned = owner
          ? !(await ownerAlive(owner))
          : text !== null && (await ownerless(claimFile));
        if (orphaned) {
          logWarn(`removing orphaned stale-removal claim (dead pid ${owner?.pid ?? "unknown"})`);
          await removeStaleFile(claimFile, text, { label, depth: 0, rootLockFile: lockFile });
        }
      } catch {
        // A busy guard or a failed removal leaves this claim for a later scan.
      }
    }
  } catch {
    // The lock is already held; a failed scan leaves only claim files.
  }
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
    startTime: await ownStartTime(),
    nonce: randomUUID(),
  });
  const tempFile = `${lockFile}.${process.pid}.${LOCK_TEMP_TOKEN}.${lockTempCounter++}.tmp`;
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

// Removes lock temp files whose creating pid is gone. Only a marker with a token
// is removed: its path belongs to one process, so once that process is dead no
// other process can write it. A marker without a token (the `<pid>.<n>.tmp` name
// of an older version) is shared by every process that reuses the pid, so a pid
// query cannot prove it orphaned and it is never removed here. A live contender's
// temp is never touched; failures are ignored because cleanup is best-effort and
// must not fail the lock holder.
async function pruneStaleLockTemps(lockFile) {
  try {
    const dir = dirname(lockFile);
    const prefix = `${basename(lockFile)}.`;
    for (const entry of await readdir(dir)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const match = LOCK_TEMP_SUFFIX.exec(entry.slice(prefix.length));
      if (match === null || match[2] === undefined) {
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/;

// Epoch seconds of a `ps -o lstart=` line read under TZ=UTC and LC_ALL=C, or null
// when the line is not in that format or names a date that does not exist (the 31st
// of a 30-day month): `Date.UTC` normalizes such fields, so each must round-trip.
function parseLstart(text) {
  const match = LSTART.exec(text);
  const month = match === null ? -1 : MONTHS.indexOf(match[1]);
  if (month < 0) {
    return null;
  }
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? ms / 1000 : null;
}

// Upper bound on one `ps` or PowerShell query, so a hung one cannot hold a lock
// acquisition. The Linux read of /proc spawns nothing and has no bound.
const START_TIME_QUERY_MS = 5000;

// Output of `command` run under TZ=UTC and LC_ALL=C, trimmed; "" when the command
// fails, times out after START_TIME_QUERY_MS, or prints nothing.
async function queryOutput(command, args) {
  const stdout = await new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
          timeout: START_TIME_QUERY_MS,
          windowsHide: true,
        },
        (err, out) => resolve(err ? "" : String(out)),
      );
    } catch {
      resolve("");
    }
  });
  return stdout.trim();
}

// Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat, joined with the
// PID namespace of this process and the boot id. Ticks and boot id are independent of
// the wall clock, so a clock step (NTP, a manual set, a suspend) never changes the
// stamp of a running process, and the boot id keeps the ticks of one boot from
// matching another. The namespace (the inode in the target of /proc/self/ns/pid) keeps
// a pid of another PID namespace, such as a container that shares the runs root, from
// being compared with a process of this one. The command name (field 2) can hold
// spaces and parentheses, so fields count from the last ")".
// The /proc mount must be a view of the PID namespace of this process, the one that
// `process.kill(pid, 0)` and the lock content use: in a mount of an ancestor namespace,
// /proc/<pid>/stat can describe an unrelated process, because pids are allocated per
// namespace (and a /proc/self link can equal `process.pid` there by coincidence).
// `ownProcView` checks the NSpid line of /proc/self/status. proc_pid_status(5) (man7.org,
// "NSpid", since Linux 4.1) states that the entries are the pid in each PID namespace of
// which the process is a member, the leftmost with respect to the namespace of the process
// that mounted the procfs, followed by the value in each nested inner namespace. A single
// entry therefore means the mount's namespace is the namespace of this process, and the
// entry is the pid in it. The check is on the writer (own stamp) and the reader (stamp of
// the owner pid) alike. It proves that the namespace of the mounter equals the namespace of
// this process, and nothing more: it does not prove that `pid` in /proc is the lock owner
// (that is the stamp comparison), and it does not cover a kernel that lacks NSpid.
// A missing NSpid line, an unreadable status, and any other form give no stamp, and the
// owner reads as alive (the pid-only check).
async function ownProcView() {
  const status = await readFile("/proc/self/status", "utf8");
  const entries = /^NSpid:[ \t]*(.*)$/m.exec(status)?.[1].trim().split(/\s+/);
  return entries?.length === 1 && entries[0] === String(process.pid);
}

// The PID namespace inode of this process (the target of /proc/self/ns/pid), or
// undefined when it cannot be read or does not parse.
async function readerPidNamespace() {
  try {
    return /^pid:\[(\d+)\]$/.exec(await readlink("/proc/self/ns/pid"))?.[1];
  } catch {
    return undefined;
  }
}

async function linuxProcStamp(pid) {
  if (!(await ownProcView())) {
    return null;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const namespace = await readerPidNamespace();
  const stamp = `linux-proc:${namespace}:${bootId}:${fields[19]}`;
  return parseStamp(stamp) === null ? null : stamp;
}

/**
 * Start-time stamp of the process `pid`, `<kind>:<value>`, or null when it cannot
 * be read (a missing platform source, or a failed, timed-out, empty, or unparseable
 * read). Callers compare only stamps of one kind. The kind is chosen by platform:
 * - `linux-proc`: /proc stat ticks, boot id, and PID namespace (no spawn, clock
 *   independent).
 * - `darwin-lstart`: epoch seconds of `ps -o lstart=` under TZ=UTC and LC_ALL=C. The
 *   kernel stores the start time (`p_starttime`) once at process creation and `ps`
 *   formats it, so a clock step afterward does not change it (from the XNU source;
 *   not exercised here, since the test machine cannot step its clock).
 * - `win32-creation`: epoch seconds of the process creation time, from PowerShell
 *   (`Process.StartTime`, the creation FILETIME that Windows stores at creation;
 *   likewise not exercised under a clock step).
 * Any other platform has no stamp, and its locks read as alive. No native dependency.
 */
export async function processStartTime(pid) {
  try {
    if (process.platform === "linux") {
      return await linuxProcStamp(pid);
    }
    if (process.platform === "darwin") {
      const time = parseLstart(await queryOutput("ps", ["-o", "lstart=", "-p", String(pid)]));
      return time === null ? null : `darwin-lstart:${time}`;
    }
    if (process.platform === "win32") {
      const text = await queryOutput("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[DateTimeOffset]::new([System.Diagnostics.Process]::GetProcessById(${pid}).StartTime).ToUnixTimeSeconds()`,
      ]);
      return /^\d{1,15}$/.test(text) ? `win32-creation:${text}` : null;
    }
  } catch {
    // An unreadable source has no stamp.
  }
  return null;
}

let ownStartTimeQuery;

// The start time stamp of this process, read once on the first lock creation: the
// lock content of every acquisition carries it. Linux reads /proc; macOS spawns one
// `ps`; Windows spawns one PowerShell (a startup that was not measured, bounded by
// START_TIME_QUERY_MS). Node has no cheaper source of the OS start time:
// `process.uptime()` stops during a system sleep on POSIX, so `Date.now()` minus it
// is not the start time.
// known-limit: the Windows spawn is paid once by each process that takes a lock.
function ownStartTime() {
  ownStartTimeQuery ??= processStartTime(process.pid).then((stamp) => stamp ?? undefined);
  return ownStartTimeQuery;
}

// Two reads of one process on the fixed-at-creation sources differ by at most this
// many seconds: it covers their one-second resolution only, not a clock step.
const START_TIME_TOLERANCE_S = 2;

const EPOCH_STAMP = {
  "darwin-lstart": /^darwin-lstart:(\d{1,15})$/,
  "win32-creation": /^win32-creation:(\d{1,15})$/,
};
const LINUX_STAMP =
  /^linux-proc:(\d{1,20}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,20})$/i;

// The structure of a stamp, or null when it is not exactly one of the known forms:
// `linux-proc:<namespace>:<boot id>:<ticks>`, or `<darwin-lstart|win32-creation>:
// <epoch seconds>` with plain digits, so a value that is empty, signed, fractional,
// exponential, or not finite never parses.
function parseStamp(text) {
  if (typeof text !== "string") {
    return null;
  }
  const linux = LINUX_STAMP.exec(text);
  if (linux !== null) {
    return {
      kind: "linux-proc",
      namespace: linux[1],
      boot: linux[2].toLowerCase(),
      ticks: linux[3],
    };
  }
  for (const [kind, pattern] of Object.entries(EPOCH_STAMP)) {
    const match = pattern.exec(text);
    if (match !== null) {
      return { kind, seconds: Number(match[1]) };
    }
  }
  return null;
}

// True when two stamps name different processes. Anything that is not a plain
// mismatch of one structure is not different, and the caller reads it as alive: a
// stamp that does not parse (either one), a kind mismatch, and a `linux-proc` pair of
// different PID namespaces, where the pid of the recorded owner means another process
// here and no stamp comparison is meaningful.
function startTimesDiffer(recorded, current) {
  const a = parseStamp(recorded);
  const b = parseStamp(current);
  if (a === null || b === null || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "linux-proc") {
    return a.namespace === b.namespace && (a.boot !== b.boot || a.ticks !== b.ticks);
  }
  return Math.abs(a.seconds - b.seconds) > START_TIME_TOLERANCE_S;
}

// True when the owner of a lock or claim still runs. Checks in order:
// 1. A valid `linux-proc` stamp whose PID namespace differs from the reader, or any
//    valid `linux-proc` stamp while the reader namespace cannot be read, reads as alive
//    before the pid probe, whether its pid is alive here or not. A differing namespace
//    means the recorded pid belongs to another namespace (a container that shares the
//    runs root), so `pidAlive` cannot say whether that owner runs. An unreadable
//    reader namespace means the reader cannot tell whether the stamp namespace is its
//    own, so it keeps the lock. Other stamp kinds skip this step.
// 2. A dead pid reads as dead, with any stamp or none (the pid-only check).
// 3. A live pid reads as dead only when its recorded stamp and the stamp of the process
//    now at that pid are valid, of one kind, and differ (see `startTimesDiffer`): the
//    pid was reused. Every other live pid reads as alive: no recorded stamp (an older
//    version, or an owner that could not read its own), an invalid stamp, a kind
//    mismatch, and a current read that is null (failed, timed out, empty, or
//    unparseable).
// known-limit: step 1 never takes a lock over, even when its owner is dead: a crashed
// owner of another namespace, and a crashed owner of this namespace when the reader
// cannot read its own PID namespace, keep the lock until a person checks that the owner
// is gone and removes the lock file (and any `.reap.<digest>` claim beside it).
async function ownerAlive(owner) {
  const recorded = parseStamp(owner.startTime);
  if (recorded?.kind === "linux-proc" && recorded.namespace !== (await readerPidNamespace())) {
    return true;
  }
  if (!pidAlive(owner.pid)) {
    return false;
  }
  if (typeof owner.startTime !== "string") {
    return true;
  }
  const current = await processStartTime(owner.pid);
  return current === null || !startTimesDiffer(owner.startTime, current);
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
