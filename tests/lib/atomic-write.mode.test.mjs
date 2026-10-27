import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { writeFileAtomic } from "../../src/lib/atomic-write.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "agent-loop-atomic-"));
  dirs.push(dir);
  return dir;
}

// Usefulness: verifies the `mode` option sets the permission bits of a newly created file, which
// the installer relies on to keep a private settings file private. 0o444 is the one mode that
// Windows and POSIX both report.
test("writeFileAtomic gives a new file the requested mode", async () => {
  const dir = await makeDir();
  const target = join(dir, "settings.json");

  await writeFileAtomic(target, "data", { mode: 0o444 });

  expect((await stat(target)).mode & 0o777).toBe(0o444);
  await chmod(target, 0o644);
});

// Usefulness: verifies the `mode` option also applies when the write replaces an existing file, so
// a restore can carry the mode of its backup.
test("writeFileAtomic replaces an existing file with the requested mode and leaves no temp", async () => {
  const dir = await makeDir();
  const target = join(dir, "settings.json");
  await writeFile(target, "old");

  await writeFileAtomic(target, "new", { mode: 0o444 });

  expect((await stat(target)).mode & 0o777).toBe(0o444);
  expect((await readdir(dir)).sort()).toEqual(["settings.json"]);
  await chmod(target, 0o644);
});

// Usefulness: verifies a state write still succeeds after PID reuse leaves a temp file with a
// predictable `<pid>.<n>.tmp` name, as it did before the `exclusive` option existed.
test("writeFileAtomic overwrites a leftover temp file with a predictable name", async () => {
  const dir = await makeDir();
  const target = join(dir, "state.json");
  for (let n = 0; n < 20; n += 1) {
    await writeFile(`${target}.${process.pid}.${n}.tmp`, "leftover");
  }

  await writeFileAtomic(target, "data");

  expect(await readFile(target, "utf8")).toBe("data");
});
