import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { killTreeOnExit } from "../src/lib/exec-tree.mjs";
import { removePath } from "./runtime-helpers.mjs";

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
