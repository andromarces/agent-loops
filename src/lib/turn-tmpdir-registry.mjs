import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logWarn } from "./log.mjs";
import { tmpRoot } from "./tmp-root.mjs";

// The turn directories of every agent-loop process on the host, as one small file per directory
// under the runs root (issue #1240, ADR 0069). The file is named for the directory and holds its
// device and inode, so an entry counts as registered only while it is the directory that was
// created. The file is untrusted input, because a turn can write to the runs root too: the report
// only marks a registered entry and never leaves one out.

// The suffix of a `mkdtemp` name is six characters of this set.
export const TURN_DIR_NAME = /^al-[A-Za-z0-9]{6}$/;

const MAX_BYTES = 64;
const IDENTITY = /^\d{1,20}:\d{1,20}$/;

const registryDir = () => join(tmpRoot("AGENT_LOOP_RUNS_ROOT", "runs"), "turn-tmpdirs");

/**
 * Registers the turn directory `name`, which has the device and inode of `stat` (read with
 * `bigint`). A failed write warns and never throws: the process still leaves out its own names.
 */
export async function registerTurnTmpdir(name, stat) {
  try {
    await mkdir(registryDir(), { recursive: true, mode: 0o700 });
    await writeFile(join(registryDir(), name), `${stat.dev}:${stat.ino}`);
  } catch (err) {
    logWarn(
      `turn temporary directory not registered, a concurrent report can list it: ${name}: ${firstErrorLine(readableErrorText(err))}`,
    );
  }
}

/** Removes the registration of `name`. A failure is ignored: a stale file hides only its own identity. */
export async function unregisterTurnTmpdir(name) {
  await rm(join(registryDir(), name), { force: true }).catch(() => {});
}

/**
 * True when `name`, an entry of the inherited temporary directory `parent`, is the directory that
 * an agent-loop process registered: the name has the shape of a turn directory, a registration of
 * it exists, and the entry now has the recorded device and inode. Any unreadable or malformed
 * registration reads as not registered.
 */
export async function isRegisteredTurnTmpdir(parent, name) {
  if (!TURN_DIR_NAME.test(name)) return false;
  try {
    const file = join(registryDir(), name);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_BYTES) return false;
    const recorded = (await readFile(file, "utf8")).trim();
    if (!IDENTITY.test(recorded)) return false;
    const entry = await lstat(join(parent, name), { bigint: true });
    return entry.isDirectory() && recorded === `${entry.dev}:${entry.ino}`;
  } catch {
    return false;
  }
}
