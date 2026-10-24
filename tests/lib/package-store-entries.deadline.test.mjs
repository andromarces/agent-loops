import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath } from "../runtime-helpers.mjs";

const calls = vi.hoisted(() => ({ count: 0, slowPath: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const counted =
    (fn) =>
    async (...args) => {
      calls.count++;
      if (args[0] === calls.slowPath) await new Promise((resolve) => setTimeout(resolve, 60));
      return fn(...args);
    };
  return {
    ...real,
    default: real,
    opendir: counted(real.opendir),
    readdir: counted(real.readdir),
    stat: counted(real.stat),
    open: counted(real.open),
    readFile: counted(real.readFile),
  };
});
const { snapshotPackageStore } = await import("../../src/lib/package-store-entries.mjs");

let store;
beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "package-store-deadline-"));
  for (let i = 0; i < 40; i++) {
    await mkdir(join(store, `v${i}`, "links"), { recursive: true });
    await mkdir(join(store, `v${i}`, "projects"), { recursive: true });
    await writeFile(join(store, `v${i}`, "index.db"), "index");
  }
  vi.stubEnv("npm_config_store_dir", store);
});
afterEach(async () => {
  calls.slowPath = null;
  vi.unstubAllEnvs();
  await removePath(store);
});

// Usefulness: verifies requirement "the read stops at its time bound" (issue #1045): after the
// bound the traversal itself ends, so no file system call starts once the snapshot has returned.
test("the traversal starts no file system call after the time bound", async () => {
  expect(await snapshotPackageStore({ boundMs: 0 })).toBeNull();
  const atReturn = calls.count;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(calls.count).toBe(atReturn);
});

// Usefulness: verifies the unbounded read reaches every version directory, so the test above
// proves a stop and not a store that is too small to read in time.
test("a read inside the bound lists every version directory", async () => {
  const before = calls.count;
  const snapshot = await snapshotPackageStore();
  expect(snapshot.size).toBe(40);
  expect(calls.count - before).toBeGreaterThan(80);
});

// Usefulness: verifies requirement "no file system call may start after the bound" (issue #1045)
// for the calls that resolve the store, not only the traversal: a call that is slow past the bound
// must not be followed by another call.
test.each(["the work tree", "the recorded store file"])(
  "no call starts after a slow call on %s outlasts the bound",
  async (which) => {
    const cwd = await mkdtemp(join(tmpdir(), "package-store-cwd-"));
    try {
      vi.stubEnv("npm_config_store_dir", undefined);
      const recorded = join(cwd, "node_modules", ".modules.yaml");
      await mkdir(join(cwd, "node_modules"));
      await writeFile(recorded, JSON.stringify({ storeDir: join(store, "v0") }));
      calls.slowPath = which === "the work tree" ? cwd : recorded;
      await snapshotPackageStore({ cwd, boundMs: 20 });
      const atReturn = calls.count;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(calls.count).toBe(atReturn);
    } finally {
      await removePath(cwd);
    }
  },
);
