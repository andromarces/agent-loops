import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { writeTextAtomic } from "../../src/install/fsutil.mjs";
import { install, uninstall } from "../../src/install/installer.mjs";
import { installRoot, manifestLockFile, manifestPath } from "../../src/install/manifest.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";
import {
  PACKAGE_ROOT,
  makeHome,
  trackHome,
  cleanupHomes,
  writeJson,
  readText,
} from "./install-helpers.mjs";

const TEMP_VARS = ["TMPDIR", "TEMP", "TMP"];
const lockFiles = [];

afterEach(async () => {
  await cleanupHomes();
  for (const lockFile of lockFiles) {
    await removePath(lockFile);
  }
  lockFiles.length = 0;
});

// Usefulness: verifies acceptance #193 — a second install or uninstall that
// starts while a first install holds the manifest lock refuses without writing,
// so the first read-modify-write of the manifest cannot lose another command's
// record. The uninstall contender runs against a real held lock, not a fake one.
test("a second install or uninstall started during a first refuses without writing", async () => {
  const home = await makeHome();
  let releaseFirst;
  const firstHolds = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let signalHolding;
  const holding = new Promise((resolve) => {
    signalHolding = resolve;
  });
  const write = async (path, ...rest) => {
    signalHolding();
    await firstHolds;
    return writeTextAtomic(path, ...rest);
  };

  const first = install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT, write });
  await holding;

  const contenders = [
    () => install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }),
    () => uninstall({ home }),
  ];
  for (const run of contenders) {
    const error = await run().then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/locked by a live process/);
  }
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);

  releaseFirst();
  await first;
  expect(existsSync(manifestPath(home))).toBe(true);
});

// Usefulness: verifies acceptance #193 — install and uninstall both refuse while
// a live process holds the lock and change no file, and the refusal names the
// install manifest so the message is actionable.
test("install and uninstall refuse while a live lock is held", async () => {
  const home = await makeHome();
  const settingsPath = join(home, ".claude", "settings.json");
  await writeJson(settingsPath, { hooks: { PreToolUse: [] } });
  const before = await readText(settingsPath);
  const lockFile = manifestLockFile(home);
  lockFiles.push(lockFile);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );

  for (const run of [
    () => install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }),
    () => uninstall({ home }),
  ]) {
    const error = await run().then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/install manifest is locked by a live process/);
  }
  expect(await readText(settingsPath)).toBe(before);
  expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(false);
  expect(existsSync(manifestPath(home))).toBe(false);
});

// Usefulness: verifies acceptance #193 — a lock left by a dead process is
// recovered: the next install removes it, proceeds, and releases it.
test("a stale lock from a dead process is recovered", async () => {
  const home = await makeHome();
  const lockFile = manifestLockFile(home);
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(
    lockFile,
    JSON.stringify({ pid: await deadPid(), startedAt: "2026-01-01T00:00:00Z" }),
    "utf8",
  );

  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(existsSync(manifestPath(home))).toBe(true);
  expect(existsSync(lockFile)).toBe(false);
});

// Usefulness: verifies acceptance #193 — a relative spelling and a different
// letter case on Windows of one install home resolve to the same lock, so the
// commands contend instead of writing the manifest concurrently.
test("equivalent install home spellings share one lock", async () => {
  const home = await makeHome();
  const key = manifestLockFile(home);
  expect(manifestLockFile(join(home, "."))).toBe(key);
  expect(manifestLockFile(relative(process.cwd(), home))).toBe(key);
  if (process.platform === "win32") {
    expect(manifestLockFile(home.toUpperCase()).toLowerCase()).toBe(key.toLowerCase());
  }
});

// Usefulness: verifies #198 — a second install or uninstall that runs with a
// different TMPDIR/TEMP than the first still contends on the one lock of the
// install home, so a sandboxed harness cannot overwrite the first manifest record.
test("install and uninstall contend across differing temp roots", async () => {
  const home = await makeHome();
  const otherRoot = await mkdtemp(join(tmpdir(), "agent-loop-other-temp-"));
  trackHome(otherRoot);
  let releaseFirst;
  const firstHolds = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let signalHolding;
  const holding = new Promise((resolve) => {
    signalHolding = resolve;
  });
  const write = async (path, ...rest) => {
    signalHolding();
    await firstHolds;
    return writeTextAtomic(path, ...rest);
  };

  const first = install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT, write });
  await holding;

  const saved = Object.fromEntries(TEMP_VARS.map((name) => [name, process.env[name]]));
  const errors = [];
  try {
    for (const name of TEMP_VARS) {
      process.env[name] = otherRoot;
    }
    for (const run of [
      () => install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT }),
      () => uninstall({ home }),
    ]) {
      errors.push(
        await run().then(
          () => null,
          (err) => err,
        ),
      );
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  for (const error of errors) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/locked by a live process/);
  }

  releaseFirst();
  await first;
  expect(existsSync(manifestPath(home))).toBe(true);
});

// Usefulness: verifies #198 — the lock sits beside `<home>/.agent-loops`, not
// inside it, and is released, so a full uninstall leaves the home empty.
test("the lock lives beside the manifest directory and leaves the home empty after uninstall", async () => {
  const home = await makeHome();
  expect(manifestLockFile(home).startsWith(installRoot(home) + sep)).toBe(false);
  expect(manifestLockFile(home).startsWith(home + sep)).toBe(true);
  await install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT });
  expect(existsSync(manifestLockFile(home))).toBe(false);
  await uninstall({ home });
  expect(await readdir(home)).toEqual([]);
});
