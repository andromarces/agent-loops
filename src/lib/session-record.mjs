import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sha256 } from "./hash.mjs";
import { logWarn } from "./log.mjs";
import { resolveWriteTarget, writeFileAtomic } from "./runstate.mjs";

// A session record keeps the pre-assigned session id of a Claude first turn outside the work tree,
// for a headless run whose `--transcript` is inside it (ADR 0027). The mutation check of an
// orchestrator or reviewer turn covers every file of the work tree, so the loop cannot write the
// transcript there during such a turn. The record is untrusted input. It holds only the id, the
// unconfirmed mark, and the fields that bind it to one transcript state.

const real = (path) => realpath(path).catch(() => resolve(path));
const identity = (path) =>
  stat(path, { bigint: true }).then(
    (info) => `${info.dev}:${info.ino}`,
    () => null,
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = ["orchestrator", "reviewer"];
const FIELDS = [
  "cwd",
  "role",
  "runNonce",
  "sessionId",
  "sessionUnconfirmed",
  "transcript",
  "transcriptSha256",
  "version",
];
const MAX_BYTES = 4096;
// A test on a non-string value would coerce it, so an array that holds a UUID would pass.
const isUuid = (value) => typeof value === "string" && UUID.test(value);

/**
 * True when `path` is inside the directory `root`. The test compares file identity (device and
 * inode) along the ancestors of the real path and along the ancestors of the path as written, so a
 * case alias, a symlink, and a directory inside a submodule all count as inside, which a comparison
 * of path text would miss. The path as written also catches a Windows junction inside the tree that
 * points outside it: the real path is outside, but Git follows the junction and lists the file.
 * The write target of a file symlink counts too, because the write lands there (#658).
 */
export async function isInside(root, path) {
  const rootId = await identity(root);
  const target = await resolveWriteTarget(path).catch(() => resolve(path));
  for (const start of [await real(dirname(path)), dirname(resolve(path)), dirname(target)]) {
    for (let dir = start; ; dir = dirname(dir)) {
      const id = await identity(dir);
      if (id !== null && id === rootId) return true;
      if (dirname(dir) === dir) break;
    }
  }
  return false;
}

// The key names one transcript by the identity of the directory and the lowercase file name of its
// write target, so a case alias of the path and a file symlink to it find the same record (#658).
async function recordKey(transcript) {
  const target = await resolveWriteTarget(transcript).catch(() => resolve(transcript));
  const dir = await real(dirname(target));
  const where = (await identity(dir)) ?? dir;
  return sha256(`${where}\0${basename(target).toLowerCase()}`).slice(0, 32);
}

/** The path of the record of one transcript file. */
export async function sessionRecordPath(transcript) {
  return join(tmpdir(), "agent-loops", "session-records", `${await recordKey(transcript)}.json`);
}

/**
 * Replaces the record of `transcript`, atomically. `runNonce` is a random value of this run, which
 * the transcript file also holds. `transcriptSha256` is the digest of the transcript file that the
 * loop wrote last. Together they bind the record to one run and one state of the file.
 * @param {string} transcript
 * @param {{ cwd: string, runNonce: string, transcriptSha256: string, role: string, sessionId: string }} fields
 */
export async function writeSessionRecord(
  transcript,
  { cwd, runNonce, transcriptSha256, role, sessionId },
) {
  const file = await sessionRecordPath(transcript);
  const record = {
    version: 1,
    transcript: await recordKey(transcript),
    cwd,
    runNonce,
    transcriptSha256,
    role,
    sessionId,
    sessionUnconfirmed: true,
  };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(record));
}

/** Removes the record of `transcript`. A failure is ignored: a stale record never binds. */
export async function removeSessionRecord(transcript) {
  await rm(await sessionRecordPath(transcript), { force: true }).catch(() => {});
}

/**
 * The role and session id of the record of `transcript`, or null. The record counts only when all
 * of these hold: it is a small regular file of the current user, it has exactly the fields of
 * `writeSessionRecord` with string values of the right form, it names this transcript, `cwd`, and
 * `runNonce`, and its digest equals `digest`, the digest of the transcript bytes now. A later
 * transcript write changes the digest, so a stale record never binds, whatever the file times are.
 * A record that fails any other test is refused with a warning.
 * @param {string} transcript
 * @param {{ digest: string, cwd: string, runNonce: unknown }} bound
 * @returns {Promise<{ role: string, sessionId: string } | null>}
 */
export async function readSessionRecord(transcript, { digest, cwd, runNonce }) {
  let file;
  let text;
  try {
    file = await sessionRecordPath(transcript);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_BYTES) return refuse(file, "not a small regular file");
    if (process.getuid && info.uid !== process.getuid())
      return refuse(file, "not owned by the user");
    text = await readFile(file, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : refuse(file, "unreadable");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return refuse(file, "not valid JSON");
  }
  const shaped =
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).sort().join() === FIELDS.join() &&
    record.version === 1 &&
    ROLES.includes(record.role) &&
    isUuid(record.sessionId) &&
    isUuid(record.runNonce) &&
    record.sessionUnconfirmed === true;
  if (!shaped) return refuse(file, "has an unexpected shape");
  if (
    record.transcript !== (await recordKey(transcript)) ||
    record.cwd !== cwd ||
    record.runNonce !== runNonce
  ) {
    return refuse(file, "belongs to another transcript, work tree, or run");
  }
  return record.transcriptSha256 === digest
    ? { role: record.role, sessionId: record.sessionId }
    : null;
}

function refuse(file, reason) {
  logWarn(`The session record ${file} is ignored: it is ${reason}.`);
  return null;
}
