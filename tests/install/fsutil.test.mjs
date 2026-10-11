import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { writeTextAtomic } from "../../src/install/fsutil.mjs";
import { cleanupHomes, trackHome } from "./install-helpers.mjs";

afterEach(cleanupHomes);

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-fsutil-"));
  trackHome(dir);
  return dir;
}

// Usefulness: verifies that a failed rename leaves no temp file and surfaces the
// rename error, so a failed install never strands residue beside the target.
test("a failed atomic write leaves no temp file and throws the rename error", async () => {
  const dir = await makeDir();
  const target = join(dir, "target");
  // A directory at the target path makes the final rename fail.
  await mkdir(join(target, "child"), { recursive: true });

  const error = await writeTextAtomic(target, "data").catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(["EISDIR", "ENOTEMPTY", "EEXIST", "EPERM", "ENOTDIR"]).toContain(error.code);
  expect(await readdir(dir)).toEqual(["target"]);
});

// Usefulness: verifies that two writes to one path in one process use distinct
// temp files, so neither write fails on the other's rename.
test("concurrent atomic writes to one path both succeed and leave no temp file", async () => {
  const dir = await makeDir();
  const target = join(dir, "target.json");

  await Promise.all([writeTextAtomic(target, "first"), writeTextAtomic(target, "second")]);

  expect(["first", "second"]).toContain(await readFile(target, "utf8"));
  expect(await readdir(dir)).toEqual(["target.json"]);
  await rm(dir, { recursive: true, force: true });
});
