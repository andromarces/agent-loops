import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath } from "../runtime-helpers.mjs";

const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const counted =
    (fn) =>
    (...args) => {
      calls.count++;
      return fn(...args);
    };
  return {
    ...real,
    default: real,
    opendir: counted(real.opendir),
    readdir: counted(real.readdir),
    stat: counted(real.stat),
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
