import { randomBytes } from "node:crypto";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
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
export async function createReviewerScratch(cwd, { signal } = {}) {
  try {
    const root = await workTreeRoot(cwd, { signal });
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

/**
 * Removes a scratch folder and then each empty parent up to the work tree. `fs.rm` removes a
 * symbolic link or a junction as an entry and never follows it, so nothing outside the folder is
 * deleted. A failure warns and never throws, so a refused delete does not fail or halt the run.
 * The caller runs this after the post-turn snapshot, so the removal cannot hide a mutation.
 * known-limit: a parent folder that a reviewer replaced with a link is not checked.
 */
export async function removeReviewerScratch(dir) {
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
  let parent = dirname(dir);
  for (let i = 0; i < 2; i++) {
    try {
      await rmdir(parent);
    } catch {
      return;
    }
    parent = dirname(parent);
  }
}
