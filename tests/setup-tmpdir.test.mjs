import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { killTreeOnExit } from "../src/lib/exec-tree.mjs";
import { stateRoot } from "../src/lib/runstate.mjs";
import { sessionRecordsRoot } from "../src/lib/session-record.mjs";
import { slotsRoot } from "../src/lib/slots-root.mjs";
import { removePath } from "./runtime-helpers.mjs";
import { createTmpdirIsolation } from "./setup-tmpdir.mjs";

// Usefulness: a failed per-file directory creation leaves the temp variables as they were and removes nothing, so the next file does not inherit a changed or deleted TMPDIR.
test("a failed directory creation restores the temp variables and removes nothing", async () => {
  const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const removeDir = vi.fn();
  const isolation = createTmpdirIsolation({
    makeDir: async () => {
      throw new Error("disk full");
    },
    removeDir,
  });
  await expect(isolation.enter()).rejects.toThrow("disk full");
  await isolation.exit();
  expect({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual(
    before,
  );
  expect(removeDir).not.toHaveBeenCalled();
});

// Usefulness: acceptance (#1022) — a root pin inherited from an agent-loop turn must not carry a test's session, run, or slot writes to the real machine-wide roots, and must come back after the file.
test("inherited root pins are unset while a file runs, so default roots stay in its directory, then restored", async () => {
  const names = [
    "AGENT_LOOP_RUNS_ROOT",
    "AGENT_LOOP_TEST_SLOTS_ROOT",
    "AGENT_LOOP_SESSION_RECORDS_ROOT",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const pinned = Object.fromEntries(names.map((name) => [name, join(tmpdir(), "real-root", name)]));
  const isolation = createTmpdirIsolation({ removeDir: async () => {} });
  try {
    Object.assign(process.env, pinned);
    await isolation.enter();
    const inside = [stateRoot(), slotsRoot(), sessionRecordsRoot()];
    const dir = process.env.TMPDIR;
    for (const root of inside) {
      expect(root.startsWith(dir)).toBe(true);
    }
    await isolation.exit();
    expect(Object.fromEntries(names.map((name) => [name, process.env[name]]))).toEqual(pinned);
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

const ROOT_NAMES = [
  "AGENT_LOOP_RUNS_ROOT",
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_SESSION_RECORDS_ROOT",
];
const snapshot = () => Object.fromEntries(ROOT_NAMES.map((name) => [name, process.env[name]]));
const restoreSnapshot = (saved) => {
  for (const name of ROOT_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
};
const sentinelPins = () =>
  Object.fromEntries(ROOT_NAMES.map((name) => [name, join(tmpdir(), "sentinel-real-root", name)]));

// Usefulness: nested isolation (a suite that enters again) hands the inherited pins back only at the outermost exit, so a pin never leaks into the real roots or goes missing for the rest of the file.
test("a nested entry restores the outer isolated state, then the inherited pins at the outermost exit", async () => {
  const before = snapshot();
  const pinned = sentinelPins();
  const outer = createTmpdirIsolation({ removeDir: async () => {} });
  const inner = createTmpdirIsolation({ removeDir: async () => {} });
  try {
    Object.assign(process.env, pinned);
    await outer.enter();
    await outer.enter();
    await outer.exit();
    expect(snapshot()).toEqual(Object.fromEntries(ROOT_NAMES.map((name) => [name, undefined])));
    await outer.exit();
    expect(snapshot()).toEqual(pinned);
    await inner.enter();
    await inner.exit();
    expect(snapshot()).toEqual(pinned);
  } finally {
    restoreSnapshot(before);
  }
});

// Usefulness: a re-entry that fails to create its directory must not overwrite the saved inherited pins with the isolated state, or the outer exit restores the wrong values.
test("a failed re-entry keeps the inherited pins for the outermost exit", async () => {
  const before = snapshot();
  const pinned = sentinelPins();
  let calls = 0;
  const isolation = createTmpdirIsolation({
    makeDir: async (prefix) => {
      calls += 1;
      if (calls > 1) throw new Error("disk full");
      return `${prefix}stub`;
    },
    removeDir: async () => {},
  });
  try {
    Object.assign(process.env, pinned);
    await isolation.enter();
    await expect(isolation.enter()).rejects.toThrow("disk full");
    await isolation.exit();
    await isolation.exit();
    expect(snapshot()).toEqual(pinned);
  } finally {
    restoreSnapshot(before);
  }
});

// Usefulness: acceptance (#1087) — an inherited temporary-directory pin must not make the installer treat the per-file directory as a temporary root, and must come back after the file.
test("an inherited AGENT_LOOP_INHERITED_TMPDIR is unset while a file runs, then restored", async () => {
  const name = "AGENT_LOOP_INHERITED_TMPDIR";
  const before = process.env[name];
  const pinned = JSON.stringify([tmpdir()]);
  const isolation = createTmpdirIsolation({ removeDir: async () => {} });
  try {
    process.env[name] = pinned;
    await isolation.enter();
    expect(process.env[name]).toBeUndefined();
    process.env[name] = "set by the test itself";
    expect(process.env[name]).toBe("set by the test itself");
    await isolation.exit();
    expect(process.env[name]).toBe(pinned);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

const NESTED_RUN_TIMEOUT_MS = 60000;

// Usefulness: acceptance (#503) — the installer lock directory that `src` creates under `tmpdir()` stays out of the real OS temp directory. Runner caches (vite, Node compile cache) are not test output and are not asserted.
test(
  "a test run that reaches the installer lock leaves no agent-loops entry in the OS temp directory",
  async () => {
    const osTmp = await mkdtemp(join(tmpdir(), "tmpdir-isolation-"));
    try {
      // `killTreeOnExit` ends the tree on Windows when this worker exits before the nested run (issue #612).
      await killTreeOnExit(
        execa("pnpm", ["exec", "vp", "test", "run", "tests/install/installer.lock.test.mjs"], {
          env: { TMPDIR: osTmp, TEMP: osTmp, TMP: osTmp },
          extendEnv: true,
          // Bound the nested run and end its whole process tree on expiry (as `runGh`).
          // A forced timeout ended every descendant on Windows 11 and macOS (issue #513).
          timeout: NESTED_RUN_TIMEOUT_MS,
          forceKillAfterDelay: 1000,
          cleanup: true,
          killDescendants: true,
        }),
      );
      expect(await readdir(osTmp)).not.toContain("agent-loops");
    } finally {
      await removePath(osTmp);
    }
  },
  NESTED_RUN_TIMEOUT_MS + 30000,
);

// Usefulness: acceptance (#1022) — a suite that starts with the three machine-wide roots pinned to real paths (as inside an agent-loop turn) writes nothing under them. CI sets no pins, so this nested run supplies them. `default-roots.test.mjs` writes a default run state, session record, and test slot, and fails when any of them lands outside the per-file directory.
test(
  "a test run that inherits the three root pins writes nothing under them",
  async () => {
    const osTmp = await mkdtemp(join(tmpdir(), "tmpdir-isolation-"));
    const pins = {
      AGENT_LOOP_RUNS_ROOT: join(osTmp, "pinned-runs"),
      AGENT_LOOP_TEST_SLOTS_ROOT: join(osTmp, "pinned-slots"),
      AGENT_LOOP_SESSION_RECORDS_ROOT: join(osTmp, "pinned-records"),
    };
    try {
      for (const dir of Object.values(pins)) await mkdir(dir);
      await killTreeOnExit(
        execa("pnpm", ["exec", "vp", "test", "run", "tests/lib/default-roots.test.mjs"], {
          env: {
            ...pins,
            AGENT_LOOP_TEST_SLOT_HELD: undefined,
            TMPDIR: osTmp,
            TEMP: osTmp,
            TMP: osTmp,
          },
          extendEnv: true,
          timeout: NESTED_RUN_TIMEOUT_MS,
          forceKillAfterDelay: 1000,
          cleanup: true,
          killDescendants: true,
        }),
      );
      for (const dir of Object.values(pins)) {
        expect(await readdir(dir)).toEqual([]);
      }
    } finally {
      await removePath(osTmp);
    }
  },
  NESTED_RUN_TIMEOUT_MS + 30000,
);
