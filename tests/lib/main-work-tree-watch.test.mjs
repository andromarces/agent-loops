import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { startMainWorkTreeWatch } from "../../src/lib/main-work-tree-watch.mjs";
import { removePath } from "../fs-helpers.mjs";

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

// Usefulness: verifies requirement "stop settles a read in flight" (issue #1556). A read that
// outlives the turn can hold a handle or change an envelope after the turn ends.
test("stop settles a read in flight", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "main-watch-"));
  // A subdirectory reports the entry name on every platform, as the main work tree does.
  const root = join(dir, "main");
  await mkdir(root);
  let started = false;
  let aborted = false;
  const handle = startMainWorkTreeWatch(root, {
    readIgnored: (_paths, { signal }) =>
      new Promise((_resolve, reject) => {
        started = true;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  await writeFile(join(root, "one.txt"), "one\n");
  await vi.waitFor(() => expect(handle.pendingCount()).toBeGreaterThan(0), { timeout: 2_000 });
  const taking = handle.take();
  await vi.waitFor(() => expect(started).toBe(true), { timeout: 2_000 });
  await handle.stop();
  const result = await taking;
  expect(aborted).toBe(true);
  expect(result).toEqual({ candidates: [], failed: true });
});
