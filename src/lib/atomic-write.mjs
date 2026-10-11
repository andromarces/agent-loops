// Atomic file writes: a private temp file in the target directory is renamed over the destination.
import { readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Monotonic suffix for state temp files, for the same reason as the lock temp
// counter: one pid writes several temps concurrently, and a cleanup must remove
// only the file its own call created (#353).
let stateTempCounter = 0;

// A transient unlink failure clears once the holder lets go, so a failed removal
// is retried once. A persistent failure is swallowed: this runs on the way out
// of an already-failed operation, and the leftover temp is a lesser problem than
// replacing the error the caller must act on (#353).
const UNLINK_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function removeTemp(path) {
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

// Same hop limit as the common kernel symlink limit.
const MAX_LINK_HOPS = 40;

const ASYNC_FS = { realpath, readlink };
// `realpathSync.native`, not `realpathSync`: the JS `realpathSync` folds `dir-link/..` away before it
// resolves the link, while `fs.promises.realpath` and the native call apply the link first, as the OS does.
const SYNC_FS = { realpath: realpathSync.native, readlink: readlinkSync };

// The one traversal behind `resolveWriteTarget` and `resolveWriteTargetSync`. It yields each fs
// step as `{ op, path }`. The driver runs the step and sends back the result, or throws the error
// into the generator, so only the fs calls differ between the async and the sync resolver.
function* traverseWriteTarget(file) {
  let current = resolve(file);
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops += 1) {
    let dir;
    try {
      dir = yield { op: "realpath", path: dirname(current) };
    } catch {
      dir = resolve(dirname(current));
    }
    current = join(dir, basename(current));
    let target;
    try {
      target = yield { op: "readlink", path: current };
    } catch (err) {
      if (["EINVAL", "ENOENT", "ENOTDIR"].includes(err.code)) {
        return current;
      }
      throw err;
    }
    current = isAbsolute(target) ? target : `${dir}${sep}${target}`;
  }
  throw Object.assign(new Error(`Too many levels of symbolic links: ${file}`), { code: "ELOOP" });
}

/**
 * The path that a write to `file` lands at: the final target of a chain of file symlinks, which a
 * rename over a link would replace instead (#658). Each hop resolves the real directory of the link
 * first, and joins a relative target to it without normalizing, so the next hop resolves the
 * directory part of the target with `realpath`. A directory link that the target passes through
 * then applies before a `..` that follows it, as the OS applies it. `readlink` works on a dangling
 * link, where `realpath` fails. A path that is no link or does not exist resolves to itself. Every
 * guard that judges where a write lands must use this path, so the guard and the writer agree. A
 * loop fails with `ELOOP`.
 */
export async function resolveWriteTarget(file) {
  const steps = traverseWriteTarget(file);
  let step = steps.next();
  while (!step.done) {
    try {
      step = steps.next(await ASYNC_FS[step.value.op](step.value.path));
    } catch (err) {
      step = steps.throw(err);
    }
  }
  return step.value;
}

// Writes `text` to `file` atomically: a private temp file in the same directory
// is renamed over the destination, so a concurrent reader sees the old content
// or the new content, never a partial write. Node rename replaces an existing
// destination on Windows and POSIX. A file symlink keeps its link: the write
// goes to the final target, with the temp beside it (#658). A failed write or
// rename leaves the temp behind, and it sits in the state directory beside the
// lock temp, so the guard removes it and keeps the original error as the one
// that surfaces (#353).
export async function writeFileAtomic(file, text) {
  const destination = await resolveWriteTarget(file);
  const temp = `${destination}.${process.pid}.${stateTempCounter++}.tmp`;
  try {
    await writeFile(temp, text, "utf8");
    await renameWithRetry(temp, destination);
  } catch (err) {
    await removeTemp(temp);
    throw err;
  }
}

// Synchronous twin of `resolveWriteTarget`, driven by the same traversal.
function resolveWriteTargetSync(file) {
  const steps = traverseWriteTarget(file);
  let step = steps.next();
  while (!step.done) {
    try {
      step = steps.next(SYNC_FS[step.value.op](step.value.path));
    } catch (err) {
      step = steps.throw(err);
    }
  }
  return step.value;
}

/**
 * Synchronous `writeFileAtomic` for a forced exit, where no event loop turn is left (#669). It
 * resolves the target as the async write does, so a file symlink, dangling or not, keeps its link.
 * A rename that Windows refuses because a reader holds the destination fails: there is no retry
 * and no async wait. A write that stalls in the OS blocks the caller, because a sync call cannot
 * be bounded.
 */
export function writeFileAtomicSync(file, text) {
  const destination = resolveWriteTargetSync(file);
  const temp = `${destination}.${process.pid}.${stateTempCounter++}.tmp`;
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, destination);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file never existed or is gone.
    }
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
