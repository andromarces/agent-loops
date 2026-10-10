import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";

const fsCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const counted =
    (fn) =>
    (...args) => {
      fsCalls.count += 1;
      return fn(...args);
    };
  // Counts the file system calls made through the promises API, to bound the scan cost (#376).
  return { ...real, access: counted(real.access), readdir: counted(real.readdir) };
});

const { detectHarnesses } = await import("../../src/install/installer.mjs");

const DIR_COUNT = 30;
let root;
let dirs;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "detect-harnesses-"));
  dirs = [];
  for (let index = 0; index < DIR_COUNT; index += 1) {
    const dir = join(root, `bin${index}`);
    await mkdir(dir);
    dirs.push(dir);
  }
});

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(() => {
  fsCalls.count = 0;
});

const touch = (dir, name) => writeFile(join(dir, name), "");
// Windows resolves a bare command through PATHEXT, so a fake CLI needs an extension there.
const exe = (name) => (process.platform === "win32" ? `${name}.cmd` : name);

// Usefulness: verifies found harnesses come back in registry order, whatever the PATH order.
test("detectHarnesses returns found harnesses in registry order", async () => {
  await touch(dirs[2], exe("codex"));
  await touch(dirs[1], exe("claude"));
  await touch(dirs[0], exe("agy"));

  expect(await detectHarnesses({ path: dirs.join(delimiter) })).toEqual([
    "claude",
    "codex",
    "antigravity",
  ]);
});

// Usefulness: verifies a harness is detected through its second command when the first is absent.
test("detectHarnesses tries the next command of a harness until one is found", async () => {
  await touch(dirs[3], exe("antigravity"));

  expect(await detectHarnesses({ path: dirs[3] })).toEqual(["antigravity"]);
});

// Usefulness: verifies a PATH entry that does not exist is skipped, not an error.
test("detectHarnesses skips PATH entries that do not exist", async () => {
  await touch(dirs[4], exe("opencode"));
  const path = [join(root, "missing"), dirs[4]].join(delimiter);

  expect(await detectHarnesses({ path })).toEqual(["opencode"]);
});

// Usefulness: bounds the scan cost on a long PATH with no match, the case where PATH entries x PATHEXT
// x commands probes took seconds on a loaded Windows host (#376).
test("detectHarnesses makes at most one file system call per PATH entry", async () => {
  const emptyDirs = dirs.slice(10);

  expect(await detectHarnesses({ path: emptyDirs.join(delimiter) })).toEqual([]);
  expect(fsCalls.count).toBeLessThanOrEqual(emptyDirs.length);
});

// Usefulness: verifies the case-insensitive file name match that Windows needs.
test.skipIf(process.platform !== "win32")(
  "detectHarnesses matches a Windows executable name case-insensitively",
  async () => {
    await touch(dirs[5], "CODEX.CMD");

    expect(await detectHarnesses({ path: dirs[5] })).toEqual(["codex"]);
  },
);
