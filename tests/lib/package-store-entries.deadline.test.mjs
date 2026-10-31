import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath } from "../runtime-helpers.mjs";

const calls = vi.hoisted(() => ({ count: 0, dirReads: 0, slowPath: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const slow = async (path) => {
    if (path === calls.slowPath) await new Promise((resolve) => setTimeout(resolve, 60));
  };
  const counted =
    (fn) =>
    async (...args) => {
      calls.count++;
      await slow(args[0]);
      return fn(...args);
    };
  // A directory handle that counts each read of the directory, by `read()` or by iteration.
  const opendir = async (path, ...rest) => {
    calls.count++;
    await slow(path);
    const handle = await real.opendir(path, ...rest);
    const read = async () => {
      calls.dirReads++;
      return handle.read();
    };
    return {
      read,
      close: () => handle.close(),
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const entry = await read();
          return entry ? { value: entry, done: false } : { value: undefined, done: true };
        },
        return: async () => {
          await handle.close();
          return { value: undefined, done: true };
        },
      }),
    };
  };
  return {
    ...real,
    default: real,
    opendir,
    readdir: counted(real.readdir),
    stat: counted(real.stat),
    open: counted(real.open),
  };
});
const { snapshotPackageStore } = await import("../../src/lib/package-store-entries.mjs");

let store;
let cwd;
beforeEach(async () => {
  calls.dirReads = 0;
  store = await mkdtemp(join(tmpdir(), "package-store-deadline-"));
  for (let i = 0; i < 40; i++) {
    await mkdir(join(store, `v${i}`, "links"), { recursive: true });
    await mkdir(join(store, `v${i}`, "projects"), { recursive: true });
    await writeFile(join(store, `v${i}`, "index.db"), "index");
  }
  cwd = await mkdtemp(join(tmpdir(), "package-store-cwd-"));
  await mkdir(join(cwd, "node_modules"));
  await writeFile(
    join(cwd, "node_modules", ".modules.yaml"),
    JSON.stringify({ storeDir: join(store, "v0") }),
  );
});
afterEach(async () => {
  calls.slowPath = null;
  await removePath(store);
  await removePath(cwd);
});

// Usefulness: verifies requirement "the read stops at its time bound" (issue #1045): after the
// bound the traversal itself ends, so no file system call starts once the snapshot has returned.
test("the traversal starts no file system call after the time bound", async () => {
  expect(await snapshotPackageStore({ cwd, boundMs: 0 })).toBeNull();
  const atReturn = calls.count;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(calls.count).toBe(atReturn);
});

// Usefulness: verifies requirement "the bound ends the read with its named reason" (#1269): the
// warning carries the abort reason, so the helper shared by three reads must not change its text.
test("the bound ends the read with the package store read reason", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await snapshotPackageStore({ cwd, boundMs: 0 })).toBeNull();
  expect(warn).toHaveBeenCalledWith(
    "[agent-loop] warn: package store not read: read took over 0 ms",
  );
  warn.mockRestore();
});

// Usefulness: verifies the unbounded read reaches every version directory, so the test above
// proves a stop and not a store that is too small to read in time.
test("a read inside the bound lists every version directory", async () => {
  const before = calls.count;
  const snapshot = await snapshotPackageStore({ cwd });
  expect(snapshot.entries.size).toBe(40);
  expect(calls.count - before).toBeGreaterThan(80);
});

// Usefulness: verifies requirement "no file system call may start after the bound" (issue #1045)
// for the call that resolves the store: a call that is slow past the bound must not be followed
// by another call.
test("no call starts after a slow read of the recorded store file outlasts the bound", async () => {
  calls.slowPath = join(cwd, "node_modules", ".modules.yaml");
  await snapshotPackageStore({ cwd, boundMs: 20 });
  const atReturn = calls.count;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls.count).toBe(atReturn);
});

// Usefulness: verifies the same for the directory iteration: after a directory open that outlasts
// the bound, no read of the directory starts, because each read is a file system call.
test("no directory read starts after a slow directory open outlasts the bound", async () => {
  calls.slowPath = store;
  await snapshotPackageStore({ cwd, boundMs: 20 });
  const atReturn = calls.dirReads;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(calls.dirReads).toBe(atReturn);
  expect(atReturn).toBe(0);
});
