import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { writeFileAtomic } from "../../src/lib/runstate.mjs";
import { removePath, symlinkOrSkip } from "../runtime-helpers.mjs";

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runstate-symlink-"));
  await mkdir(join(dir, "repo"));
  await mkdir(join(dir, "outdir"));
});

afterEach(async () => {
  await removePath(dir);
});

// Usefulness: verifies a dangling file symlink keeps its link and the write lands at the target (#658).
test("writeFileAtomic writes through a dangling file symlink and keeps the link", async (ctx) => {
  const path = join(dir, "repo", "t.json");
  await symlinkOrSkip(ctx, join("..", "outdir", "t.json"), path);
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
  await symlinkOrSkip(ctx, target, path);
  await writeFileAtomic(path, "new");
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readFile(target, "utf8")).toBe("new");
});

// Usefulness: verifies a chain of file symlinks resolves to the final target and every link stays.
test("writeFileAtomic follows a chain of file symlinks", async (ctx) => {
  const first = join(dir, "repo", "a.json");
  const second = join(dir, "repo", "b.json");
  await symlinkOrSkip(ctx, "b.json", first);
  await symlinkOrSkip(ctx, join("..", "outdir", "c.json"), second);
  await writeFileAtomic(first, "data");
  expect((await lstat(first)).isSymbolicLink()).toBe(true);
  expect((await lstat(second)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(dir, "outdir", "c.json"), "utf8")).toBe("data");
});

// Usefulness: verifies a symlink loop fails with an error instead of a hang or a replaced link.
test("writeFileAtomic rejects a symlink loop and keeps the links", async (ctx) => {
  const first = join(dir, "repo", "a.json");
  const second = join(dir, "repo", "b.json");
  await symlinkOrSkip(ctx, "b.json", first);
  await symlinkOrSkip(ctx, "a.json", second);
  await expect(writeFileAtomic(first, "data")).rejects.toMatchObject({ code: "ELOOP" });
  expect((await lstat(first)).isSymbolicLink()).toBe(true);
});

// Usefulness: verifies a relative link target resolves against the real directory of the link, not
// the directory path as written, when the link is reached through a directory symlink.
test("writeFileAtomic resolves a relative target against the real directory of the link", async (ctx) => {
  const deep = join(dir, "real", "deep");
  await mkdir(deep, { recursive: true });
  await mkdir(join(dir, "x"));
  await symlinkOrSkip(ctx, join("..", "t.json"), join(deep, "link.json"));
  await symlinkOrSkip(ctx, deep, join(dir, "x", "alias"), "dir");
  await writeFileAtomic(join(dir, "x", "alias", "link.json"), "data");
  expect(await readFile(join(dir, "real", "t.json"), "utf8")).toBe("data");
  expect(await readdir(join(dir, "x"))).toEqual(["alias"]);
});

// Usefulness: verifies a directory link inside a relative link target applies before the `..` after it, as the OS applies it: `dl/../t.json` lands beside the directory that `dl` points to on POSIX.
test("writeFileAtomic applies a directory link inside a relative target before its dot-dot", async (ctx) => {
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "b", "deep"), { recursive: true });
  await symlinkOrSkip(ctx, join(dir, "b", "deep"), join(dir, "a", "dl"), "dir");
  // A literal string: `path.join` would fold `dl/..` away before the link is made.
  await symlinkOrSkip(ctx, "dl/../t.json", join(dir, "a", "link.json"));
  await writeFileAtomic(join(dir, "a", "link.json"), "data");
  // Windows folds `dl/..` away before it touches the file system, so there the file lands in `a`.
  const landed = process.platform === "win32" ? "a" : "b";
  expect(await readFile(join(dir, landed, "t.json"), "utf8")).toBe("data");
  expect((await readdir(join(dir, "a"))).includes("t.json")).toBe(landed === "a");
});
