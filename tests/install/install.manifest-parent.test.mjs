import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { install, uninstall } from "../../src/install/installer.mjs";
import { manifestLockFile, manifestPath } from "../../src/install/manifest.mjs";
import { PACKAGE_ROOT, cleanupHomes, makeHome, readText } from "./install-helpers.mjs";

// Windows reports ENOENT, not ENOTDIR, when a path component is a regular file.
// This stand-in makes every platform read the manifest the way Windows does.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: async (path, ...rest) => {
      if (String(path).endsWith("install.json")) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
      return actual.readFile(path, ...rest);
    },
  };
});

afterEach(cleanupHomes);

// Usefulness: verifies #491 — a manifest parent that is a regular file must stop
// install before any harness write even where the manifest read reports ENOENT
// (Windows); the Windows read is simulated, so the check runs on every platform.
test("install fails before any harness write when the manifest read reports ENOENT under a regular file", async () => {
  const home = await makeHome();
  await writeFile(join(home, ".agent-loops"), "user data\n", "utf8");

  await expect(install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT })).rejects.toThrow(
    /\.agent-loops/,
  );

  expect(existsSync(join(home, ".claude"))).toBe(false);
  expect(await readText(join(home, ".agent-loops"))).toBe("user data\n");
  // The lock lives under the OS temp root and is released on failure; nothing
  // else lands in the home.
  expect(existsSync(manifestLockFile(home))).toBe(false);
  expect(await readdir(home)).toEqual([".agent-loops"]);
});

// Usefulness: verifies #491 reaches uninstall — a regular file at the manifest
// parent must stop uninstall with an error and change nothing, as it does on POSIX.
test("uninstall fails and changes nothing when the manifest parent is a regular file", async () => {
  const home = await makeHome();
  await writeFile(join(home, ".agent-loops"), "user data\n", "utf8");

  await expect(uninstall({ home })).rejects.toThrow(/\.agent-loops/);

  expect(await readText(join(home, ".agent-loops"))).toBe("user data\n");
  expect(existsSync(manifestLockFile(home))).toBe(false);
  expect(await readdir(home)).toEqual([".agent-loops"]);
});

// Usefulness: verifies #491 leaves a fresh home alone — an absent manifest parent
// is not an error, so install still succeeds when the manifest read reports ENOENT.
test("install into a fresh home still succeeds when the manifest read reports ENOENT", async () => {
  const home = await makeHome();

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  expect(existsSync(manifestPath(home))).toBe(true);
});
