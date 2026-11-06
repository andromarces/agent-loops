import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startMainWorkTreeWatch } from "../../src/lib/main-work-tree-watch.mjs";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

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

// Usefulness: verifies requirement "an event overflow reports no field and warns" (issue #1556). An
// unbounded queue can grow with a large write burst and outlive the turn.
test("an event overflow reports no candidates and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  const handle = startMainWorkTreeWatch(dir, { maxPending: 0 });
  await writeFile(join(dir, "one.txt"), "one\n");
  await vi.waitFor(
    () => expect(warn.mock.calls.some((call) => /queued events/i.test(String(call[0])))).toBe(true),
    { timeout: 2_000 },
  );
  await expect(handle.take()).resolves.toEqual({ candidates: [], failed: true });
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

// Usefulness: verifies requirement "stop settles a real Git read in flight and logs a warning"
// (issue #1556). A read that outlives the turn can hold a handle after the turn ends.
test("stop settles a real Git read in flight and warns", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await createTempRepo();
  // A large ignore file keeps one real `git check-ignore` read in flight long enough to stop it.
  const patterns = Array.from({ length: 50_000 }, (_, index) => `ignored-${index}.txt`).join("\n");
  await writeFile(join(dir, ".gitignore"), `${patterns}\n`);
  const handle = startMainWorkTreeWatch(dir);
  await writeUntilQueued(handle, join(dir, "one.txt"));
  const taking = handle.take();
  for (let turn = 0; turn < 5_000 && !handle.ignoring(); turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(handle.ignoring()).toBe(true);
  await handle.stop();
  const result = await taking;
  expect(result).toEqual({ candidates: [], failed: true });
  expect(warn.mock.calls.some((call) => String(call[0]).includes("main work tree watch"))).toBe(
    true,
  );
});
