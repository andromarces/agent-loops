// Exclusive state lock and the owner liveness checks behind it (#173, ADR 0020). One lock file
// guards one read-modify-write of a state file or a manifest.
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { removeTemp } from "./atomic-write.mjs";
import { sha256 } from "./hash.mjs";
import { logWarn } from "./log.mjs";
import { ownStartTime, ownerAlive, pidAlive } from "./process-identity.mjs";

// An unparseable lock or claim with no live marker (see `hasLiveWriter`) is
// stale only once it is older than this. A writer of an older version that runs
// the exclusive-create fallback leaves no marker, and its file cannot be told from
// a dead one by anything but age. A file with a live marker never expires.
const STALE_LOCK_GRACE_MS = 60_000;

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

/**
 * Takes the lock at `lockFile` like `withStateLock`, but returns null instead of
 * throwing when a live or unidentified owner holds it. Returns the function that
 * removes the lock, with the nonce that this acquisition wrote in the lock as its `nonce`
 * property. Any other failure, for example an unwritable directory, throws.
 */
export async function tryStateLock(lockFile, { label = "State", noun = "state" } = {}) {
  await mkdir(dirname(lockFile), { recursive: true });
  let nonce;
  try {
    nonce = await acquireLock(lockFile, { label, noun });
  } catch (err) {
    if (err?.lockBusy) {
      return null;
    }
    throw err;
  }
  return Object.assign(() => rm(lockFile, { force: true }), { nonce });
}

/**
 * True when `lockFile` would refuse an acquisition: it cannot be read, its parsed owner is
 * alive, or it is unparseable and a writer can still own it (see `ownerless`). False only for
 * a missing file and for a stale one (a dead owner, or an unparseable file that `ownerless`
 * finds stale). Reads only; it never removes a stale lock.
 */
export async function lockHeld(lockFile) {
  let text;
  try {
    text = await readFile(lockFile, "utf8");
  } catch (err) {
    return err?.code !== "ENOENT";
  }
  const owner = parseLockOwner(text);
  return owner ? ownerAlive(owner) : !(await ownerless(lockFile));
}

/** The parsed owner record of `lockFile`, or null when it is missing or unparseable. */
export async function readLockOwner(lockFile) {
  return parseLockOwner(await readLockText(lockFile));
}

// A refusal because another owner holds the lock, as opposed to a filesystem failure.
function busyError(message) {
  return Object.assign(new Error(message), { lockBusy: true });
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

// Resolves the nonce written in the lock that this call took.
async function acquireLock(
  lockFile,
  { retry = true, label = "State", noun = "state", depth = 0, rootLockFile = lockFile } = {},
) {
  const nonce = await createLock(lockFile);
  if (nonce !== null) {
    await pruneLockDirectory(lockFile, label, depth);
    return nonce;
  }

  const lockText = await readLockText(lockFile);
  const owner = parseLockOwner(lockText);
  if (owner && (await ownerAlive(owner))) {
    throw busyError(
      `${label} is locked by a live process (pid ${owner.pid}, started ${owner.startedAt ?? "unknown"}).`,
    );
  }

  if (!owner && (lockText === null || !(await ownerless(lockFile)))) {
    // Fail closed when the owner cannot be identified: the file is missing
    // (a removal race) or cannot be read, or the exclusive-create fallback has
    // created it and its writer has not written the content yet (a live marker,
    // or a file younger than the grace window for a writer without a marker).
    throw busyError(`${label} is locked (the lock file is not readable yet; retry shortly).`);
  }

  if (!retry) {
    throw busyError(`${label} lock could not be acquired after stale removal.`);
  }

  if (depth >= MAX_CLAIM_DEPTH) {
    throw busyError(
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
// only by its winner. While a winner holds it, the stale file cannot change. Its
// owner is dead, nobody else removes it, and nobody creates a file at a path
// that exists. Every acquisition writes unique content (a nonce). A file that
// reads as the stale content under the claim is the file that was read as stale.
// Removing it cannot delete a new owner's file (#363). Nothing is renamed, and no
// path is bare-removed unclaimed. A loser finds a live claim and exits as busy.
// A file that reads differently or cannot be read is kept, and the caller's retry
// reports it as busy. A dead claim is removed through this same claimed removal,
// by a contender that meets its stale file or by `pruneOrphanClaims` (#452).
// Owner liveness: `ownerAlive`. Older-version contenders: `withStateLock`.
// known-limit: a writer of an older version that runs the exclusive-create
// fallback leaves no marker, so its unwritten file is kept only while it is
// younger than STALE_LOCK_GRACE_MS. A marker-less writer that stalls past the
// window loses the file; upgrading every agent-loop process removes the case.
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

// Cleans up beside a lock that was just taken, from one listing of its directory. A failed
// listing skips both scans: the lock is held, and only stale files stay for the next acquisition.
// Removes temp files left by a crash between the temp write and the link (#178), and at depth 0
// the orphaned claims. Runs while the lock is held and never touches a live contender's temp, so
// it cannot break a racing acquisition.
async function pruneLockDirectory(lockFile, label, depth) {
  let entries;
  try {
    entries = await readdir(dirname(lockFile));
  } catch {
    return;
  }
  await pruneStaleLockTemps(lockFile, entries);
  if (depth === 0) {
    await pruneOrphanClaims(lockFile, label, entries);
  }
}

// Matches the name of a claim file beside the lock.
const CLAIM_SUFFIX = /^\.reap\.[0-9a-f]{64}$/;

// Removes the orphaned claims beside `lockFile`: a claim whose parsed pid is dead,
// or an unparseable one that no running writer can own. Runs while the lock is
// held, through the same claimed removal as a takeover, so one process acts on
// each claim. A claim that is live, busy, or unreadable is kept. Best-effort: a
// failure leaves the claim for the next acquisition and never fails the holder.
async function pruneOrphanClaims(lockFile, label, entries) {
  try {
    const dir = dirname(lockFile);
    const prefix = basename(lockFile);
    for (const entry of entries) {
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
// and write keeps the lock usable at the cost of that window. Returns the nonce of
// the content written, or null only when another owner already holds the lock.
async function createLock(lockFile) {
  // The nonce makes every acquisition's content unique, so a re-read that matches
  // the stale content can only be the same file, never a later owner (#363). A
  // lock written without one by an older version parses the same way.
  const nonce = randomUUID();
  const owner = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startTime: await ownStartTime(),
    nonce,
  });
  const tempFile = `${lockFile}.${process.pid}.${LOCK_TEMP_TOKEN}.${lockTempCounter++}.tmp`;
  // The write is inside the guard because it creates the temp file: a write cut
  // short leaves a partial temp behind, and the prune never removes a temp owned
  // by the running process, so nothing else would clean it (#353).
  try {
    await writeFile(tempFile, owner, "utf8");
    const created = await linkLock(tempFile, lockFile, owner);
    await removeTemp(tempFile);
    return created ? nonce : null;
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
async function pruneStaleLockTemps(lockFile, entries) {
  try {
    const dir = dirname(lockFile);
    const prefix = `${basename(lockFile)}.`;
    for (const entry of entries) {
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
