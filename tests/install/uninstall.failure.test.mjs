// Uninstall must surface a directory-removal failure instead of hiding it and
// dropping the manifest record (#192). The `rmdir` mock below applies to the
// whole module graph, so this file stays separate from install.test.mjs, whose
// cases need the real filesystem (same reason as runstate.link-fallback.test.mjs).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { main as cliMain } from "../../src/cli.mjs";
import { removeDirQuiet } from "../../src/install/fsutil.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { installRoot, manifestPath, readManifest } from "../../src/install/manifest.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Caller-set path -> error code for a forced `rmdir` failure.
const control = vi.hoisted(() => ({ failures: new Map() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rmdir: vi.fn(async (path, ...rest) => {
      const code = control.failures.get(path);
      if (code) {
        const err = new Error(`${code}: forced rmdir failure, rmdir '${path}'`);
        err.code = code;
        err.path = path;
        throw err;
      }
      return actual.rmdir(path, ...rest);
    }),
  };
});

const homes = [];

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-uninstall-failure-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  control.failures.clear();
  for (const home of homes) {
    await rm(home, { recursive: true, force: true });
  }
  homes.length = 0;
});

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function deepestDir(dirs) {
  return [...dirs].sort((a, b) => b.length - a.length)[0];
}

// Usefulness: verifies acceptance #192 — a missing directory and a non-empty
// directory are silent, including the EEXIST that some platforms report for a
// non-empty directory. This is the suppression contract the two failure paths
// rely on, so it is not redundant with them.
test("removeDirQuiet stays silent for a missing or non-empty directory", async () => {
  const home = await makeHome();
  const missing = join(home, "missing");
  await expect(removeDirQuiet(missing)).resolves.toBe(false);

  const nonEmpty = join(home, "non-empty");
  await mkdir(nonEmpty, { recursive: true });
  await writeFile(join(nonEmpty, "keep.txt"), "keep\n", "utf8");
  await expect(removeDirQuiet(nonEmpty)).resolves.toBe(false);
  expect(existsSync(join(nonEmpty, "keep.txt"))).toBe(true);

  const forced = join(home, "forced");
  control.failures.set(forced, "EEXIST");
  await expect(removeDirQuiet(forced)).resolves.toBe(false);

  const empty = join(home, "empty");
  await mkdir(empty, { recursive: true });
  await expect(removeDirQuiet(empty)).resolves.toBe(true);
});

// Usefulness: verifies acceptance #192 path 1 — a permission failure removing a
// harness directory is reported and the harness record stays in the manifest, so
// a later uninstall can retry. The directory itself is left in place.
test("a harness directory removal failure is reported and keeps the record", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const dirs = (await readManifest(home)).harnesses.claude.dirs;
  const blocked = deepestDir(dirs);
  control.failures.set(blocked, "EPERM");

  const reports = await uninstall({ home });

  const failure = reports.find((entry) => entry.path === blocked);
  expect(failure?.action).toBe("failed");
  expect(failure?.detail).toMatch(/retry/);
  expect(existsSync(blocked)).toBe(true);

  const manifest = await readManifest(home);
  expect(manifest.harnesses.claude).toBeDefined();
  expect(manifest.harnesses.claude.dirs).toContain(blocked);
});

// Usefulness: verifies the reinstall regression from #192 — the kept directory
// record must not block the next install. The stale file and settings records
// would make install read a missing recorded entry and skip the whole harness.
test("a reinstall after a harness directory failure is not blocked", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const blocked = deepestDir((await readManifest(home)).harnesses.claude.dirs);
  control.failures.set(blocked, "EPERM");
  await uninstall({ home });
  control.failures.clear();

  const reports = await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(reports.find((entry) => entry.kind === "settings").action).not.toBe("skip");
  expect(reports.find((entry) => entry.kind === "file").action).not.toBe("skip");
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(true);
});

// Usefulness: verifies the reporting gap from the review — a successful retry
// after a directory failure names the directories it removed, so the command
// does not print "Nothing to change." while it clears the leftover directory.
test("a successful retry reports the directories it removed", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const blocked = deepestDir((await readManifest(home)).harnesses.claude.dirs);
  control.failures.set(blocked, "EPERM");
  await uninstall({ home });
  control.failures.clear();

  const reports = await uninstall({ home });
  expect(reports.find((entry) => entry.path === blocked)?.action).toBe("delete");
  expect(reports.some((entry) => entry.action === "failed")).toBe(false);
  expect(existsSync(blocked)).toBe(false);
  expect(await readText(manifestPath(home))).toBe(null);
});

// Usefulness: verifies acceptance #192 path 2 — a permission failure removing
// the install directory names the leftover directory and asks for a manual
// cleanup, because the manifest is already deleted.
test("an install directory removal failure names the directory and asks for manual cleanup", async () => {
  const home = await makeHome();
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });

  const root = installRoot(home);
  control.failures.set(root, "EPERM");

  const error = await uninstall({ home }).then(
    () => null,
    (err) => err,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain(root);
  expect(error.message).toMatch(/manually/);
  expect(await readText(manifestPath(home))).toBe(null);
});

// Usefulness: verifies acceptance #192 path 2 at the command boundary — the
// uninstall CLI reports the leftover install directory and exits 1.
test("the uninstall CLI exits 1 when the install directory cannot be removed", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  control.failures.set(installRoot(home), "EPERM");

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => logs.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["uninstall", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain(installRoot(home));
    expect(logs.join("\n")).toMatch(/manually/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    delete process.env.AGENT_LOOP_HOME;
    process.exitCode = 0;
  }
});
