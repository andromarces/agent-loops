import { lstat, mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";

// Short on purpose: a deep path fails some runtimes on Windows (issue #903).
const PREFIX = "al-";

/**
 * Runs `run(env)` with a private temporary directory for one child turn and removes it afterward
 * on every outcome. `env` sets `TMPDIR`, `TEMP`, and `TMP` to the directory, which `mkdtemp`
 * creates under the inherited temporary directory with a unique name, so the child and its
 * commands leave nothing in the inherited one and a concurrent process never loses an entry
 * (issue #955). `env` is undefined, after a warning, when the directory cannot be created. A
 * failed removal warns and never fails the turn. The caller awaits the child first, so no child
 * of the turn is left to write into the directory.
 */
export async function withTurnTmpdir(run) {
  let dir = null;
  let parentReal = null;
  try {
    dir = await mkdtemp(join(tmpdir(), PREFIX));
    parentReal = await realpath(dirname(dir));
    logDebug(`turn temporary directory created: ${dir}`);
  } catch (err) {
    logWarn(
      `turn temporary directory not created, the turn uses the inherited one: ${firstErrorLine(readableErrorText(err))}`,
    );
    if (dir !== null) await removeTurnTmpdir(dir, dirname(dir));
    dir = null;
  }
  try {
    return await run(dir === null ? undefined : { TMPDIR: dir, TEMP: dir, TMP: dir });
  } finally {
    if (dir !== null) await removeTurnTmpdir(dir, parentReal);
  }
}

/**
 * Removes the directory that `withTurnTmpdir` created. It first refuses, with a warning and no
 * deletion, when the real path of the parent changed since creation, because a path through a
 * swapped link deletes content outside the directory. A link at the directory itself is unlinked
 * as an entry, and `fs.rm` unlinks a link inside it as an entry and never follows it.
 * known-limit: a swap of the parent between the check and `fs.rm` is not prevented, because Node
 * has no directory-handle delete. The check runs immediately before the removal.
 */
async function removeTurnTmpdir(dir, parentReal) {
  try {
    if ((await realpath(dirname(dir))) !== parentReal) {
      logWarn(`turn temporary directory not removed, its parent changed: ${dir}`);
      return;
    }
    const stat = await lstat(dir);
    if (stat.isSymbolicLink()) await unlink(dir);
    else await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    logDebug(`turn temporary directory removed: ${dir}`);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    logWarn(
      `turn temporary directory not removed, delete it by hand: ${dir}: ${firstErrorLine(readableErrorText(err))}`,
    );
  }
}
