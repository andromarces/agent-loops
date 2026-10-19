import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { stateRoot } from "./runstate.mjs";
import { sessionRecordsRoot } from "./session-record.mjs";
import { slotsRoot } from "./test-slot.mjs";

const execFileAsync = promisify(execFile);
const REMOVER = fileURLToPath(new URL("./turn-tmpdir-remove.mjs", import.meta.url));
const REMOVER_REFUSED = 3;
const REMOVER_TIMEOUT_MS = 30_000;

// Short on purpose: a deep path fails some runtimes on Windows (issue #903).
const PREFIX = "al-";

// Each machine-wide root defaults to a path under `os.tmpdir()`, so the child needs the value that
// the parent resolves. A value that the user already set is kept.
const ROOT_PINS = [
  ["AGENT_LOOP_RUNS_ROOT", stateRoot],
  ["AGENT_LOOP_TEST_SLOTS_ROOT", slotsRoot],
  ["AGENT_LOOP_SESSION_RECORDS_ROOT", sessionRecordsRoot],
];

/**
 * Runs `run(env)` with a private temporary directory for one child turn and removes it afterward
 * on every outcome. `env` sets `TMPDIR`, `TEMP`, and `TMP` to the directory, which `mkdtemp`
 * creates under the inherited temporary directory with a unique name, so the child and its
 * commands leave nothing in the inherited one and a concurrent process never loses an entry
 * (issue #955). `env` also pins the runs root, the test-slot directory, and the session-record
 * directory to the paths that the parent resolves, so the child shares them with every other
 * process on the host. A value that the user set for one of those overrides wins. `env` is
 * undefined, after a warning, when the directory cannot be created. A failed removal warns and
 * never fails the turn. The caller awaits the child first, so no child of the turn is left to
 * write into the directory.
 */
export async function withTurnTmpdir(run) {
  let dir = null;
  let parentReal = null;
  const pins = {};
  for (const [name, resolveRoot] of ROOT_PINS) {
    if (!process.env[name]) pins[name] = resolveRoot();
  }
  try {
    dir = await mkdtemp(join(tmpdir(), PREFIX));
    parentReal = dirname(await realpath(dir));
    logDebug(`turn temporary directory created: ${dir}`);
  } catch (err) {
    logWarn(
      `turn temporary directory not created, the turn uses the inherited one: ${firstErrorLine(readableErrorText(err))}`,
    );
    if (dir !== null) await removeTurnTmpdir(dir, dirname(dir));
    dir = null;
  }
  try {
    return await run(dir === null ? undefined : { ...pins, TMPDIR: dir, TEMP: dir, TMP: dir });
  } finally {
    if (dir !== null) await removeTurnTmpdir(dir, parentReal);
  }
}

/**
 * Removes the directory that `withTurnTmpdir` created, in a short-lived child that holds the
 * parent as its working directory and then the directory itself (`turn-tmpdir-remove.mjs`). The
 * child refuses, deleting nothing, when the real path of the parent changed since creation or
 * when the target is no longer the directory that was checked. It unlinks a link at the target as
 * an entry. A swap of the target or of a parent path component, at any moment, never steers a
 * delete outside the directory. A refusal and a failure warn and never throw.
 * known-limit: a directory nested below the target can still be swapped during the delete,
 * because Node has no directory-handle delete.
 */
async function removeTurnTmpdir(dir, parentReal) {
  try {
    await execFileAsync(process.execPath, [REMOVER, parentReal, basename(dir)], {
      cwd: dirname(dir),
      timeout: REMOVER_TIMEOUT_MS,
      windowsHide: true,
    });
    logDebug(`turn temporary directory removed: ${dir}`);
  } catch (err) {
    logWarn(
      err?.code === REMOVER_REFUSED
        ? `turn temporary directory not removed, its path changed: ${dir}`
        : `turn temporary directory not removed, delete it by hand: ${dir}: ${firstErrorLine(readableErrorText(err))}`,
    );
  }
}
