import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { main as cliMain } from "../../src/cli.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { manifestLockFile, manifestPath } from "../../src/install/manifest.mjs";
import { restoreAgentLoopHome } from "../runtime-helpers.mjs";
import { PACKAGE_ROOT, cleanupHomes, makeHome } from "./install-helpers.mjs";

// `onMissing` runs once, synchronously, right after an existence check of `path`
// reports the path absent. It lets a test change the disk between that check and
// the next read, as a concurrent install would. The real check still runs first.
const probe = vi.hoisted(() => ({ path: null, onMissing: null }));

function afterMissingCheck(path) {
  if (probe.path !== null && path === probe.path && probe.onMissing) {
    const run = probe.onMissing;
    probe.onMissing = null;
    run();
  }
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: (path) => {
      const found = actual.existsSync(path);
      if (!found) {
        afterMissingCheck(path);
      }
      return found;
    },
    lstatSync: (path, ...rest) => {
      try {
        return actual.lstatSync(path, ...rest);
      } catch (err) {
        if (err?.code === "ENOENT") {
          afterMissingCheck(path);
        }
        throw err;
      }
    },
  };
});

afterEach(async () => {
  probe.path = null;
  probe.onMissing = null;
  restoreAgentLoopHome();
  process.exitCode = 0;
  await cleanupHomes();
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

// Usefulness: verifies #570 keeps ADR 0025 — an install that creates the home and
// takes the lock after uninstall saw the home missing must not lose its targets
// or manifest. The disk changes between the existence check and the next read;
// an uninstall that then mutates without the lock deletes both.
test("uninstall does not mutate a home that an install takes after the existence check", async () => {
  const parent = await makeHome();
  const home = join(parent, "home");
  const aside = join(parent, "home.aside");
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  const settings = join(home, ".claude", "settings.json");
  expect(existsSync(settings)).toBe(true);
  renameSync(home, aside);
  probe.path = home;
  probe.onMissing = () => {
    renameSync(aside, home);
    writeFileSync(
      manifestLockFile(home),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
  };

  await uninstall({ home }).catch(() => {});

  expect(probe.onMissing).toBeNull();
  expect(existsSync(settings)).toBe(true);
  expect(existsSync(manifestPath(home))).toBe(true);
});
