import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ afterStat: null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    stat: async (...args) => {
      const result = await real.stat(...args);
      const hook = hooks.afterStat;
      hooks.afterStat = null;
      await hook?.();
      return result;
    },
  };
});

const { writeTextAtomic } = await import("../../src/install/fsutil.mjs");

const dirs = [];
afterEach(async () => {
  hooks.afterStat = null;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Usefulness: verifies the mode lookup and the write use the same resolved file, so a parent link
// that is retargeted between the two cannot make the writer apply one file's mode to another.
test("writeTextAtomic replaces the file whose mode it read when a parent link is retargeted", async (ctx) => {
  const root = await mkdtemp(join(tmpdir(), "agent-loop-retarget-"));
  dirs.push(root);
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "link");
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(first, "settings.json"), "first");
  await writeFile(join(second, "settings.json"), "second");
  await chmod(join(second, "settings.json"), 0o444);
  try {
    await symlink(first, link, "junction");
  } catch (err) {
    if (process.platform === "win32" && err?.code === "EPERM") ctx.skip();
    throw err;
  }
  hooks.afterStat = async () => {
    await unlink(link).catch(() => rm(link, { recursive: true }));
    await symlink(second, link, "junction");
  };

  await writeTextAtomic(join(link, "settings.json"), "written");

  expect(await readFile(join(first, "settings.json"), "utf8")).toBe("written");
  expect(await readFile(join(second, "settings.json"), "utf8")).toBe("second");
  expect((await stat(join(second, "settings.json"))).mode & 0o777).toBe(0o444);
  await chmod(join(second, "settings.json"), 0o644);
});
