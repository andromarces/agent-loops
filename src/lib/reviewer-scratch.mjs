import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { firstErrorLine, readableErrorText } from "./error-message.mjs";
import { logDebug, logWarn } from "./log.mjs";
import { workTreeRoot } from "./snapshot.mjs";

// Short on purpose: a deep path fails some test runtimes on Windows (issue #903).
const SCRATCH_PARENT = join(".agent-loop", "rev");

/**
 * Creates the scratch folder of one reviewer turn at `<work tree root>/.agent-loop/rev/<id>` and
 * returns its path, or null after a warning when it cannot be created. A run never fails for it.
 * The folder holds a `.gitignore` with `*`, which ignores the folder and that file, so it needs no
 * rule in the target repository and holds in a linked work tree, where `.git` is a file. Git lists
 * no directory whose files are all ignored, so the mutation check sees none of it.
 */
export async function createReviewerScratch(cwd, { signal, rootOf } = {}) {
  try {
    const root = await (rootOf ?? ((b) => workTreeRoot(cwd, b)))({ signal });
    const dir = join(root, SCRATCH_PARENT, randomBytes(4).toString("hex"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitignore"), "*\n");
    logDebug(`reviewer scratch folder created: ${dir}`);
    return dir;
  } catch (err) {
    logWarn(
      `reviewer scratch folder not created, the turn runs without it: ${firstErrorLine(readableErrorText(err))}`,
    );
    return null;
  }
}

async function isMissing(path) {
  try {
    await lstat(path);
    return false;
  } catch (err) {
    return err.code === "ENOENT";
  }
}

// True when `path` is a real directory. A link or junction, a file, and a missing entry are not.
// `lstat` never follows the entry itself, and Node reports a Windows junction as a symbolic link.
async function isRealDirectory(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Removes a scratch folder and then each empty parent up to the work tree. It first refuses, with a
 * warning and no deletion, when `.agent-loop` or `.agent-loop/rev` is not a real directory, because
 * a path through a link deletes content outside the folder. A missing parent means nothing is
 * left to remove. A link at the folder itself is unlinked as an entry. `fs.rm` removes a symbolic
 * link or a junction inside the folder as an entry and never follows it. A failure warns and never
 * throws, so a refused delete does not fail or halt the run. The caller runs this after the
 * post-turn snapshot, so the removal cannot hide a mutation.
 * known-limit: a swap of a parent between the check and `fs.rm` is not prevented, because Node has
 * no directory-handle delete. The check runs immediately before `fs.rm` to keep that window short.
 */
export async function removeReviewerScratch(dir) {
  const rev = dirname(dir);
  const parent = dirname(rev);
  for (const component of [parent, rev]) {
    if (await isRealDirectory(component)) continue;
    if (await isMissing(component)) return;
    logWarn(
      `reviewer scratch folder not removed, ${component} is a link or not a directory: ${dir}`,
    );
    return;
  }
  try {
    await rm(dir, { recursive: true, force: true });
    logDebug(`reviewer scratch folder removed: ${dir}`);
  } catch (err) {
    logWarn(
      `reviewer scratch folder not removed, delete it by hand: ${dir}: ${firstErrorLine(readableErrorText(err))}`,
    );
    return;
  }
  // `rmdir` fails on a folder that still holds an entry, so another turn's folder stays.
  for (const emptyParent of [rev, parent]) {
    try {
      await rmdir(emptyParent);
    } catch {
      return;
    }
  }
}
