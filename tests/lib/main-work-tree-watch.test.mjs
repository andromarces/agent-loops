import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startMainWorkTreeWatch } from "../../src/lib/main-work-tree-watch.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { processExists } from "../process-helpers.mjs";

let dir;
afterEach(async () => {
  if (dir) await removePath(dir);
  dir = undefined;
});

// Usefulness: verifies requirement "a watch that fails to start reports no field and warns" (issue
// #1556). A silent start failure reads as no main work tree change.
test("a watch that fails to start warns and returns no handle", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  const handle = startMainWorkTreeWatch(join(dir, "missing"));
  expect(handle).toBeNull();
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "a pending overflow reports no field and warns" (issue #1556).
// An unbounded queue can grow with a large write burst and outlive the turn.
test("a pending overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  const handle = startMainWorkTreeWatch(dir, { maxPending: 0 });
  await vi.waitFor(
    async () => {
      await writeFile(join(dir, "one.txt"), "one\n");
      expect(warn.mock.calls.some((call) => /queued paths/i.test(String(call[0])))).toBe(true);
    },
    { timeout: 5_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
});

// Usefulness: verifies requirement "a seen-file overflow reports no field and warns" (issue #1556).
// A silent drop loses a path that an in-window read saw.
test("a seen-file overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = startMainWorkTreeWatch(dir, { maxSeenFiles: 0 });
  await vi.waitFor(
    async () => {
      await writeFile(join(dir, "one.txt"), "one\n");
      expect(warn.mock.calls.some((call) => /seen files/i.test(String(call[0])))).toBe(true);
    },
    { timeout: 5_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
});

// Usefulness: verifies requirement "a candidate overflow reports no field and warns" (issue #1556).
// A silent drop of a non-ignored path leaves the field incomplete.
test("a candidate overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = startMainWorkTreeWatch(dir, { maxCandidates: 0 });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const result = await handle.take();
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => /changed paths/i.test(String(call[0])))).toBe(true);
});

/** Writes `path` until the watch queues the event, so a late watch start cannot miss the write. */
async function writeUntilQueued(handle, path) {
  await vi.waitFor(
    async () => {
      await writeFile(path, "queued\n");
      expect(handle.pendingCount()).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
}

// Usefulness: verifies requirement "a file created and removed inside the window is reported"
// (issue #1556). An in-window read saw the file, so its path belongs in the field.
test("a file created and removed inside the window is reported", async () => {
  dir = await createTempRepo();
  const handle = startMainWorkTreeWatch(dir);
  await writeUntilQueued(handle, join(dir, "scratch.txt"));
  await vi.waitFor(() => expect(handle.seenFileCount()).toBeGreaterThan(0), { timeout: 2_000 });
  await rm(join(dir, "scratch.txt"), { force: true });
  const result = await handle.take();
  expect(result).toEqual({ candidates: ["scratch.txt"], failed: false });
});

// Usefulness: verifies requirement "a direct stop before take reports a failure and warns" (issue
// #1556). A stop that no read failure explains must still log the watch warning.
test("a direct stop before take reports a failure and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  const handle = startMainWorkTreeWatch(dir);
  await writeUntilQueued(handle, join(dir, "one.txt"));
  await handle.stop();
  const result = await handle.take();
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});

// Usefulness: verifies requirement "repeated events for one path queue one read" (issue #1556). A
// burst for one open path must not grow the queue or repeat the real Git read.
test("repeated events for one path queue one read", async () => {
  dir = await createTempRepo();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const handle = startMainWorkTreeWatch(dir, {
    beforeIgnoreInputEnds: async () => {
      reads++;
      started();
      await hold;
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const taking = handle.take();
  try {
    await startedP;
    for (let index = 0; index < 50; index++) {
      await writeFile(join(dir, "one.txt"), `change-${index}\n`);
    }
    // Let the queued events reach the watcher while the read is held.
    for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(handle.pendingCount()).toBe(1);
  } finally {
    release();
  }
  const result = await taking;
  expect(reads).toBe(1);
  expect(result).toEqual({ candidates: ["one.txt"], failed: false });
});

// Usefulness: verifies requirement "stop ends a real Git child held in flight" (issue #1556). A
// read that outlives the turn can hold a handle or a child after the turn ends.
test("stop ends a real Git child held in flight", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let pid;
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  const handle = startMainWorkTreeWatch(dir, {
    beforeIgnoreInputEnds: async ({ pid: childPid }) => {
      pid = childPid;
      started();
      await hold;
    },
  });
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const taking = handle.take();
  try {
    await startedP;
    expect(processExists(pid)).toBe(true);
    const stopping = handle.stop();
    await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 2_000 });
    release();
    await stopping;
    const result = await taking;
    expect(result).toEqual({ candidates: [], failed: true });
    expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
      true,
    );
  } finally {
    release();
  }
});
