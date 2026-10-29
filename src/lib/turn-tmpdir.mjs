import { lstat, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { execBounded } from "./exec.mjs";
import { INHERITED_TMPDIR_ENV, inheritedTmpdirsForChild } from "./inherited-tmpdir.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { readProcessTable } from "./process-ancestry.mjs";
import { ownerAlive } from "./process-identity.mjs";
import { rootPins } from "./root-pins.mjs";

const REMOVER = fileURLToPath(new URL("./turn-tmpdir-remove.mjs", import.meta.url));
const REMOVER_REFUSED = 3;
// The removal helper normally ends in milliseconds. A turn waits this long at most, then 1 s more
// for the forced end that `execBounded` sends after a refused SIGTERM.
const REMOVAL_BOUND_MS = 30_000;

// Short on purpose: a deep path fails some runtimes on Windows (issue #903).
const PREFIX = "al-";

// Names of the directories that this process created and has not finished removing. Only these
// exact names are the runtime's own: the prefix alone is not, because a reviewer can create
// `al-probe`. A name leaves the set when the removal ends, whatever its outcome.
const createdNames = new Set();

/** True for the name of a turn directory that this process created and has not finished removing. */
export const isTurnTmpdirName = (name) => createdNames.has(name);

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
 * ends at `removalBoundMs`, so the turn never waits longer for it. `onCreated(record)` is awaited
 * after the creation and before `run`, with the record that `removeAbandonedTurnTmpdir` needs, so
 * a caller can persist it ahead of a process death. A failed `onCreated` is a precondition failure:
 * `run` never starts, the directory is removed, and the error is thrown to the caller.
 */
export async function withTurnTmpdir(run, { removalBoundMs = REMOVAL_BOUND_MS, onCreated } = {}) {
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
    if (created !== null && onCreated) await onCreated({ ...created });
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
  createdNames.add(basename(dir));
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
  } finally {
    // A directory that the removal refused or failed on stays in place, and its name is no longer
    // the runtime's own, so a report can list it (issue #1024).
    createdNames.delete(basename(dir));
  }
}

// The suffix of a `mkdtemp` name is six characters of this set.
const TURN_DIR_NAME = /^al-[A-Za-z0-9]{6}$/;

/**
 * Removes the turn directory of a process that died before it could, from the record that
 * `onCreated` of `withTurnTmpdir` received, plus `child`, the `{ pid, startTime }` of the child of
 * the turn that the dispatcher added after the spawn. The directory stays, with a warning, while a
 * process of the dead turn may still use it: a record with no child, a child that `ownerAlive`
 * reads as running or cannot read, on POSIX, a live process group that the child led, and, on
 * Windows, a live process below the recorded pid. The group is the one that `exec` makes with
 * `killDescendants`: its id is the pid of the child and stays reserved while any member runs, so
 * the group names a descendant that was reparented. A Windows `.cmd` shim ends with its dispatcher
 * while the CLI that it started keeps running, and the table keeps the parent pid of that CLI. A
 * process table that cannot be read keeps the directory too. Otherwise the removal is the one of a
 * normal turn: it acts only on a directory with the recorded device and inode, so a directory that is gone or
 * that something replaced is not followed. A record that is not the shape of a created turn
 * directory is refused without a removal, and so is a record whose parent is not the real path of
 * the temporary directory that this call inherited, because a turn directory is created there only.
 * Every outcome other than a removal warns and never throws.
 * known-limit: a POSIX descendant that left the group of the child, and a Windows descendant below
 * a chain with no live link, are not found. A group id that the OS reused for a new group after the
 * old one ended keeps the directory, with the warning.
 */
export async function removeAbandonedTurnTmpdir(record, boundMs = REMOVAL_BOUND_MS) {
  if (record === undefined || record === null) return;
  const { dir, parentReal, device, inode, child } = record;
  const wellFormed =
    [dir, parentReal, device, inode].every((value) => typeof value === "string") &&
    isAbsolute(dir) &&
    isAbsolute(parentReal) &&
    TURN_DIR_NAME.test(basename(dir));
  if (!wellFormed) {
    logWarn("turn temporary directory not removed, the recorded directory is not a turn directory");
    return;
  }
  if (!(await inInheritedTmpdir(parentReal))) {
    logWarn(
      `turn temporary directory not removed, the recorded parent is not the temporary directory of this call: ${dir}`,
    );
    return;
  }
  if (!Number.isInteger(child?.pid) || child.pid <= 0) {
    logWarn(
      `turn temporary directory kept, no child of the dead turn is recorded and one may still run: ${dir}`,
    );
    return;
  }
  if (await ownerAlive(child)) {
    logWarn(
      `turn temporary directory kept, a child of the dead turn may still run (pid ${child.pid}): ${dir}`,
    );
    return;
  }
  if (process.platform !== "win32" && processGroupAlive(child.pid)) {
    logWarn(
      `turn temporary directory kept, a process in the group of the dead child may still run (group ${child.pid}): ${dir}`,
    );
    return;
  }
  if (process.platform === "win32") {
    let below;
    try {
      below = liveBelow(child.pid, await readProcessTable());
    } catch (err) {
      logWarn(
        `turn temporary directory kept, the process table cannot be read: ${dir}: ${firstErrorLine(readableErrorText(err))}`,
      );
      return;
    }
    if (below !== null) {
      logWarn(
        `turn temporary directory kept, a process of the dead turn may still run (pid ${below}): ${dir}`,
      );
      return;
    }
  }
  await removeTurnTmpdir({ dir, parentReal, device, inode }, boundMs);
}

// True unless no process runs in the POSIX process group `pgid`. A signal 0 reaches no process
// and fails with ESRCH only when the group is empty. Any other error keeps the group as alive.
function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

// True when `parentReal` is the real path of the temporary directory that this process inherited.
async function inInheritedTmpdir(parentReal) {
  try {
    return (await realpath(resolve(tmpdir()))) === parentReal;
  } catch {
    return false;
  }
}

// The pid of a live process that descends from `rootPid` through the parent pids of `table`, or null.
function liveBelow(rootPid, table) {
  const reached = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { pid, ppid } of table) {
      if (reached.has(ppid) && !reached.has(pid)) {
        reached.add(pid);
        grew = true;
      }
    }
  }
  reached.delete(rootPid);
  return reached.values().next().value ?? null;
}
