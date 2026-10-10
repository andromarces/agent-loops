import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { writeFileAtomic } from "../../src/lib/runstate.mjs";
import { removePath } from "../runtime-helpers.mjs";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runstate-symlink-"));
  await mkdir(join(dir, "repo"));
  await mkdir(join(dir, "outdir"));
});

afterEach(async () => {
  await removePath(dir);
});

async function link(target, path, ctx) {
  try {
    await symlink(target, path);
  } catch (err) {
    // A Windows host without symlink privilege refuses the call.
    if (err?.code === "EPERM") ctx.skip();
    throw err;
  }
}

// Usefulness: verifies a dangling file symlink keeps its link and the write lands at the target
// (issue #658); a rename over the link would replace the link itself.
test("writeFileAtomic writes through a dangling file symlink and keeps the link", async (ctx) => {
  const path = join(dir, "repo", "t.json");
  await link(join("..", "outdir", "t.json"), path, ctx);
  await writeFileAtomic(path, "data");
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readlink(path)).toBe(join("..", "outdir", "t.json"));
  expect(await readFile(join(dir, "outdir", "t.json"), "utf8")).toBe("data");
  expect(await readdir(join(dir, "repo"))).toEqual(["t.json"]);
  expect(await readdir(join(dir, "outdir"))).toEqual(["t.json"]);
});

// Usefulness: verifies an existing file symlink keeps its link and the target content is replaced.
test("writeFileAtomic writes through an existing file symlink and keeps the link", async (ctx) => {
  const path = join(dir, "repo", "t.json");
  const target = join(dir, "outdir", "t.json");
  await writeFile(target, "old");
  await link(target, path, ctx);
  await writeFileAtomic(path, "new");
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toBe("new");
});

// Usefulness: verifies a chain of file symlinks resolves to the final target and every link stays.
test("writeFileAtomic follows a chain of file symlinks", async (ctx) => {
  const first = join(dir, "repo", "a.json");
  const second = join(dir, "repo", "b.json");
  await link("b.json", first, ctx);
  await link(join("..", "outdir", "c.json"), second, ctx);
  await writeFileAtomic(first, "data");
  expect((await lstat(first)).isSymbolicLink()).toBe(true);
  expect((await lstat(second)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(dir, "outdir", "c.json"), "utf8")).toBe("data");
});

// Usefulness: verifies a symlink loop fails with an error instead of a hang or a replaced link.
test("writeFileAtomic rejects a symlink loop and keeps the links", async (ctx) => {
  const first = join(dir, "repo", "a.json");
  const second = join(dir, "repo", "b.json");
  await link("b.json", first, ctx);
  await link("a.json", second, ctx);
  await expect(writeFileAtomic(first, "data")).rejects.toMatchObject({ code: "ELOOP" });
  expect((await lstat(first)).isSymbolicLink()).toBe(true);
});
