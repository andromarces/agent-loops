import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { execBounded } from "./exec.mjs";
import { INHERITED_TMPDIR_ENV, inheritedTmpdirsForChild } from "./inherited-tmpdir.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { rootPins } from "./root-pins.mjs";

const REMOVER = fileURLToPath(new URL("./turn-tmpdir-remove.mjs", import.meta.url));
const REMOVER_REFUSED = 3;
// The removal helper normally ends in milliseconds. A turn waits this long at most, then 1 s more
// for the forced end that `execBounded` sends after a refused SIGTERM.
const REMOVAL_BOUND_MS = 30_000;

// Short on purpose: a deep path fails some runtimes on Windows (issue #903).
const PREFIX = "al-";

/**
 * Runs `run(env)` with a private temporary directory for one child turn and removes it afterward
 * on every outcome. `env` sets `TMPDIR`, `TEMP`, and `TMP` to the directory, which `mkdtemp`
 * creates under the inherited temporary directory with a unique name, so the child and its
 * commands leave nothing in the inherited one and a concurrent process never loses an entry
 * (issue #955). `env` also pins the runs root, the test-slot directory, and the session-record
 * directory to the paths that the parent resolves, so the child shares them with every other
 * process on the host. A value that the user set for one of those overrides wins. `env` also
 * lists the inherited temporary directories in `AGENT_LOOP_INHERITED_TMPDIR`, for the installer
 * check of a package-runner root. `env` is undefined, after a warning, when the directory cannot
 * be created. A failed or refused removal warns and never fails the turn. The caller awaits the
 * child first, so no child of the turn is left to write into the directory. The removal helper
 * ends at `removalBoundMs`, so the turn never waits longer for it.
 */
export async function withTurnTmpdir(run, { removalBoundMs = REMOVAL_BOUND_MS } = {}) {
  let created = null;
  const pins = rootPins();
  const inherited = inheritedTmpdirsForChild(tmpdir());
  try {
    created = await createTurnTmpdir();
    logDebug(`turn temporary directory created: ${created.dir}`);
  } catch (err) {
    logWarn(
      `turn temporary directory not created, the turn uses the inherited one: ${firstErrorLine(readableErrorText(err))}`,
    );
  }
  try {
    const dir = created?.dir;
    return await run(
      created === null
        ? undefined
        : { ...pins, [INHERITED_TMPDIR_ENV]: inherited, TMPDIR: dir, TEMP: dir, TMP: dir },
    );
  } finally {
    if (created !== null) await removeTurnTmpdir(created, removalBoundMs);
  }
}

/**
 * Creates the directory and records what the removal needs to recognize it: the real path of the
 * parent and the device and inode of the directory.
 * known-limit: a replacement between `mkdtemp` and the `lstat` is recorded as the directory. The
 * name is random and exists only after `mkdtemp`, and Node cannot create a directory and read its
 * identity in one call.
 */
async function createTurnTmpdir() {
  // Absolute, so the child reads the same path from any working directory.
  const dir = await mkdtemp(join(resolve(tmpdir()), PREFIX));
  const stat = await lstat(dir, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  return {
    dir,
    parentReal: dirname(await realpath(dir)),
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

/**
 * Removes the directory that `withTurnTmpdir` created, in a short-lived helper process
 * (`turn-tmpdir-remove.mjs`) that `execBounded` ends at `boundMs`, by SIGTERM and then SIGKILL, or
 * by `taskkill` on Windows, and that `killTreeOnExit` registers for the end of this process. The
 * helper acts only on a directory with the recorded device and inode, and refuses, deleting
 * nothing, on any other. A replacement before or during the removal loses nothing, and a swap of
 * a parent path component cannot steer a delete. A refusal, a failure, a timeout, and a kill warn
 * and never throw.
 * known-limit: a directory nested below the target can still be swapped during the delete, and a
 * replacement between the final identity check and the `rmdir` loses at most an empty directory,
 * because Node has no directory-handle delete. The identity check relies on the device and inode
 * that the platform reports, which is not verified on Windows (issue #709). A mismatch there
 * refuses and leaves the directory in place.
 */
async function removeTurnTmpdir({ dir, parentReal, device, inode }, boundMs) {
  const failure = (reason) =>
    logWarn(`turn temporary directory not removed, delete it by hand: ${dir}: ${reason}`);
  try {
    const result = await execBounded(
      process.execPath,
      [REMOVER, parentReal, basename(dir), device, inode],
      { cwd: dirname(dir), timeoutMs: boundMs },
    );
    if (result.exitCode === 0) {
      logDebug(`turn temporary directory removed: ${dir}`);
    } else if (result.timedOut) {
      failure(`the removal helper did not end within ${boundMs} ms and was killed`);
    } else if (result.exitCode === REMOVER_REFUSED) {
      logWarn(`turn temporary directory not removed, it is not the directory created: ${dir}`);
    } else {
      failure(
        firstErrorLine(
          readableErrorText(result.stderr || result.shortMessage || "the removal helper failed"),
        ),
      );
    }
  } catch (err) {
    failure(firstErrorLine(readableErrorText(err)));
  }
}
