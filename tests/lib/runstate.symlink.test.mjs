import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { writeFileAtomic, writeFileAtomicSync } from "../../src/lib/runstate.mjs";
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

// The async and the sync writer share one symlink traversal (#694). Every link case below runs
// against both, so a drift between them fails a test. `run` and `fail` keep the contract of each
// writer: the async one settles a promise, the sync one returns or throws before the call returns.
const writers = [
  [
    "writeFileAtomic",
    {
      write: writeFileAtomic,
      run: (call) => call(),
      fail: (call) => expect(call()).rejects.toMatchObject({ code: "ELOOP" }),
    },
  ],
  [
    "writeFileAtomicSync",
    {
      write: writeFileAtomicSync,
      run: (call) => expect(call()).toBeUndefined(),
      fail: (call) => expect(call).toThrow(expect.objectContaining({ code: "ELOOP" })),
    },
  ],
];

for (const [name, { write: writeTarget, run, fail }] of writers) {
  const write = (path, text) => run(() => writeTarget(path, text));

  // Usefulness: verifies a dangling file symlink keeps its link and the write lands at the target (#658, #669).
  test(`${name} writes through a dangling file symlink and keeps the link`, async (ctx) => {
    const path = join(dir, "repo", "t.json");
    await symlinkOrSkip(ctx, join("..", "outdir", "t.json"), path);
    await write(path, "data");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe(join("..", "outdir", "t.json"));
    expect(await readFile(join(dir, "outdir", "t.json"), "utf8")).toBe("data");
    expect(await readdir(join(dir, "repo"))).toEqual(["t.json"]);
    expect(await readdir(join(dir, "outdir"))).toEqual(["t.json"]);
  });

  // Usefulness: verifies an existing file symlink keeps its link and the target content is replaced.
  test(`${name} writes through an existing file symlink and keeps the link`, async (ctx) => {
    const path = join(dir, "repo", "t.json");
    const target = join(dir, "outdir", "t.json");
    await writeFile(target, "old");
    await symlinkOrSkip(ctx, target, path);
    await write(path, "new");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(join(dir, "outdir"))).toEqual(["t.json"]);
  });

  // Usefulness: verifies a chain of file symlinks resolves to the final target and every link stays.
  test(`${name} follows a chain of file symlinks`, async (ctx) => {
    const first = join(dir, "repo", "a.json");
    const second = join(dir, "repo", "b.json");
    await symlinkOrSkip(ctx, "b.json", first);
    await symlinkOrSkip(ctx, join("..", "outdir", "c.json"), second);
    await write(first, "data");
    expect((await lstat(first)).isSymbolicLink()).toBe(true);
    expect((await lstat(second)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, "outdir", "c.json"), "utf8")).toBe("data");
  });

  // Usefulness: verifies a symlink loop fails with ELOOP instead of a hang or a replaced link, and leaves no temp file.
  test(`${name} rejects a symlink loop with ELOOP and keeps the links`, async (ctx) => {
    const first = join(dir, "repo", "a.json");
    const second = join(dir, "repo", "b.json");
    await symlinkOrSkip(ctx, "b.json", first);
    await symlinkOrSkip(ctx, "a.json", second);
    await fail(() => writeTarget(first, "data"));
    expect((await lstat(first)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(dir, "repo"))).toEqual(["a.json", "b.json"]);
  });

  // Usefulness: verifies a relative target resolves against the real directory of the link when a directory symlink leads to it.
  test(`${name} resolves a relative target against the real directory of the link`, async (ctx) => {
    const deep = join(dir, "real", "deep");
    await mkdir(deep, { recursive: true });
    await mkdir(join(dir, "x"));
    await symlinkOrSkip(ctx, join("..", "t.json"), join(deep, "link.json"));
    await symlinkOrSkip(ctx, deep, join(dir, "x", "alias"), "dir");
    await write(join(dir, "x", "alias", "link.json"), "data");
    expect(await readFile(join(dir, "real", "t.json"), "utf8")).toBe("data");
    expect(await readdir(join(dir, "x"))).toEqual(["alias"]);
  });

  // Usefulness: verifies a directory link inside a relative target applies before the `..` after it, as the OS applies it.
  test(`${name} applies a directory link inside a relative target before its dot-dot`, async (ctx) => {
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b", "deep"), { recursive: true });
    await symlinkOrSkip(ctx, join(dir, "b", "deep"), join(dir, "a", "dl"), "dir");
    // A literal string: `path.join` would fold `dl/..` away before the link is made.
    await symlinkOrSkip(ctx, "dl/../t.json", join(dir, "a", "link.json"));
    await write(join(dir, "a", "link.json"), "data");
    // Windows folds `dl/..` away before it touches the file system, so there the file lands in `a`.
    const landed = process.platform === "win32" ? "a" : "b";
    expect(await readFile(join(dir, landed, "t.json"), "utf8")).toBe("data");
    expect((await readdir(join(dir, "a"))).includes("t.json")).toBe(landed === "a");
  });
}

// Usefulness: acceptance (#669) — the synchronous write creates a file that does not exist yet.
test("writeFileAtomicSync creates a missing file", async () => {
  const path = join(dir, "repo", "new.json");
  writeFileAtomicSync(path, "data");
  expect(await readFile(path, "utf8")).toBe("data");
  expect(await readdir(join(dir, "repo"))).toEqual(["new.json"]);
});
