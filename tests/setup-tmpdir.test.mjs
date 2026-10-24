import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { stateRoot } from "../src/lib/runstate.mjs";
import { sessionRecordsRoot } from "../src/lib/session-record.mjs";
import { slotsRoot } from "../src/lib/test-slot.mjs";
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
