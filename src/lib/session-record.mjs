import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sha256 } from "./hash.mjs";
import { writeFileAtomic } from "./runstate.mjs";

// A record of the headless run that lives outside the work tree, for a run whose `--transcript`
// is inside it (ADR 0027). The mutation check of an orchestrator or reviewer turn covers every file
// of the work tree, so the loop cannot write its transcript there during such a turn.

const real = (path) => realpath(path).catch(() => resolve(path));
const identity = (path) =>
  stat(path, { bigint: true }).then(
    (info) => `${info.dev}:${info.ino}`,
    () => null,
  );

/**
 * True when `path` is inside the directory `root`. The test compares file identity (device and
 * inode) along the ancestors of the path, so a case alias, a symlink, and a directory inside a
 * submodule all count as inside, which a comparison of path text would miss.
 */
export async function isInside(root, path) {
  const rootId = await identity(root);
  for (let dir = await real(dirname(path)); ; dir = dirname(dir)) {
    const id = await identity(dir);
    if (id !== null && id === rootId) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The path of the record of one transcript file, keyed by its real directory and its name. */
export async function sessionRecordPath(transcript) {
  const key = join(await real(dirname(transcript)), basename(transcript));
  return join(tmpdir(), "agent-loops", "session-records", `${sha256(key).slice(0, 32)}.json`);
}

/** Replaces the record of `transcript` with `text`, atomically. */
export async function writeSessionRecord(transcript, text) {
  const file = await sessionRecordPath(transcript);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, text);
}

/** Removes the record of `transcript`. A failure is ignored: `readSessionRecord` ignores a stale record. */
export async function removeSessionRecord(transcript) {
  await rm(await sessionRecordPath(transcript), { force: true }).catch(() => {});
}

/**
 * The text of the record of `transcript`, or null. A record counts only when it is a regular file
 * of the current user, valid JSON, and not older than the transcript file, so a record that a
 * later transcript write superseded is never read.
 */
export async function readSessionRecord(transcript) {
  try {
    const file = await sessionRecordPath(transcript);
    const info = await lstat(file);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) return null;
    const written = await stat(transcript).catch(() => null);
    if (written && written.mtimeMs > info.mtimeMs) return null;
    const text = await readFile(file, "utf8");
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}
