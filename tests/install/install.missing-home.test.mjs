import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main as cliMain } from "../../src/cli.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { manifestLockFile, manifestPath } from "../../src/install/manifest.mjs";
import { removePath, restoreAgentLoopHome } from "../runtime-helpers.mjs";
import { PACKAGE_ROOT, cleanupHomes, makeHome } from "./install-helpers.mjs";

// A path listed here reports ENOENT to `lstatSync`, as if the home did not exist
// yet at the moment of the existence check.
const ghost = vi.hoisted(() => ({ path: null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    lstatSync: (path, ...rest) => {
      if (ghost.path !== null && path === ghost.path) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
      return actual.lstatSync(path, ...rest);
    },
  };
});

const lockFiles = [];

afterEach(async () => {
  ghost.path = null;
  restoreAgentLoopHome();
  process.exitCode = 0;
  await cleanupHomes();
  for (const lockFile of lockFiles) {
    await removePath(lockFile);
  }
  lockFiles.length = 0;
});

// Usefulness: verifies acceptance #570 — the CLI `uninstall` with
// `AGENT_LOOP_HOME` at a missing path exits as before and leaves the path missing.
test("CLI uninstall with AGENT_LOOP_HOME at a missing path leaves the path missing", async () => {
  const parent = await makeHome();
  const home = join(parent, "missing-home");
  process.env.AGENT_LOOP_HOME = home;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.exitCode = 0;
    await cliMain(["uninstall", "--yes"]);
    expect(process.exitCode).toBe(0);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }

  expect(existsSync(home)).toBe(false);
  expect(await readdir(parent)).toEqual([]);
});

// Usefulness: verifies #570 keeps ADR 0025 — a home that appears after the
// existence check, with an install holding the lock, must not lose any target or
// the manifest to an uninstall that runs without the lock.
test("uninstall never mutates a home that an install holds locked after the existence check", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const settings = join(home, ".claude", "settings.json");
  expect(existsSync(settings)).toBe(true);
  const lockFile = manifestLockFile(home);
  lockFiles.push(lockFile);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
  ghost.path = home;

  await uninstall({ home }).catch(() => {});

  expect(existsSync(settings)).toBe(true);
  expect(existsSync(manifestPath(home))).toBe(true);
});
