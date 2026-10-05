import { link, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock } from "../../src/lib/runstate.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";

// A filesystem without hard links (FAT/exFAT, some network mounts) makes every
// `link` fail. Linux vfat reports EPERM and macOS reports ENOTSUP; Windows
// maps the CreateHardLinkW ERROR_INVALID_FUNCTION on FAT/exFAT to EISDIR
// (nodejs/node#65817). A partial module mock keeps the real filesystem for
// every other call; this file exists separately because the mock applies to the
// whole module and would break the real-fs cases in runstate.test.mjs (#178).
const realFs = await vi.importActual("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  writeFile: vi.fn(async (...args) => await realFs.writeFile(...args)),
  link: vi.fn(async () => {
    const err = new Error("hard links are unsupported");
    err.code = "ENOTSUP";
    throw err;
  }),
}));

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-link-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(writeFile).mockImplementation(async (...args) => await realFs.writeFile(...args));
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

// Usefulness: verifies the lock is created and its owner content written when
// the filesystem has no hard links, so a link-less runs root still works, and
// the lock is released afterwards.
test("acquires the lock where hard links are unsupported", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");

  const owner = await withStateLock(lockFile, () => readFile(lockFile, "utf8"));

  expect(JSON.parse(owner).pid).toBe(process.pid);
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

// Usefulness: verifies exclusivity survives the link-less fallback: a lock held
// by a live owner is still rejected and left in place for that owner.
test("rejects a live owner where hard links are unsupported", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );

  await expect(withStateLock(lockFile, async () => "ran")).rejects.toThrow(
    /locked by a live process/,
  );
  expect(JSON.parse(await readFile(lockFile, "utf8")).pid).toBe(process.pid);
});

// Usefulness: verifies the Windows FAT/exFAT mapping (ERROR_INVALID_FUNCTION
// surfaces as EISDIR) also falls back, so the fallback covers its main Windows
// target case.
test("acquires the lock when link fails with the Windows EISDIR mapping", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  vi.mocked(link).mockImplementationOnce(async () => {
    const err = new Error("hard links are unsupported");
    err.code = "EISDIR";
    throw err;
  });

  const owner = await withStateLock(lockFile, () => readFile(lockFile, "utf8"));

  expect(JSON.parse(owner).pid).toBe(process.pid);
  await expect(readFile(lockFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

// Usefulness: verifies the rejected #445 failure stays closed: a contender that
// meets a claim of a running process, created but not yet written, never takes it
// over at any age, so two processes never act on one claim (#452). The claim
// writer is paused inside the exclusive-create window.
test("a claim that a running process created but has not written is never taken over", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const staleOwner = JSON.stringify({ pid: await deadPid(), startedAt: "old" });
  await writeFile(lockFile, staleOwner, "utf8");
  const created = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let claimFile;
  vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
    if (options?.flag !== "wx" || !file.includes(".reap.")) {
      return await realFs.writeFile(file, data, options);
    }
    // The exclusive create of the claim: the file exists, empty, until resumed.
    claimFile = file;
    await realFs.writeFile(file, "", options);
    created.resolve();
    await resume.promise;
    await realFs.writeFile(file, data, "utf8");
  });
  const owner = withStateLock(lockFile, async () => "ran");

  await created.promise;
  await utimes(claimFile, new Date(0), new Date(0));
  const fn = vi.fn(async () => "ran");
  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/not readable yet/);

  expect(fn).not.toHaveBeenCalled();
  expect(await readFile(claimFile, "utf8")).toBe("");
  resume.resolve();
  await expect(owner).resolves.toBe("ran");
  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies PID reuse cannot delete a live writer's marker. A new
// process that reuses a pid starts its temp counter at zero, so a counter-only
// name would collide with the marker of the earlier process; the cleanup of one
// would then remove the other's marker, and the unwritten file of the live
// writer would read as ownerless (review of #488). Two fresh module instances in
// one process stand for two processes with the same pid.
test("a process that reuses a pid never removes another process's marker", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  vi.resetModules();
  const firstFs = await import("node:fs/promises");
  const first = await import("../../src/lib/runstate.mjs");
  vi.resetModules();
  const second = await import("../../src/lib/runstate.mjs");
  const created = Promise.withResolvers();
  const resume = Promise.withResolvers();
  vi.mocked(firstFs.writeFile).mockImplementationOnce(async (file, data, options) => {
    // The marker exists; the first process pauses before it creates the lock.
    await realFs.writeFile(file, data, options);
    created.resolve();
    await resume.promise;
  });
  const paused = first.withStateLock(lockFile, async () => "first");
  await created.promise;
  const markers = async () => (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  expect(await markers()).toHaveLength(1);

  await expect(second.withStateLock(lockFile, async () => "second")).resolves.toBe("second");

  expect(await markers()).toHaveLength(1);
  resume.resolve();
  await expect(paused).resolves.toBe("first");
  expect(await readdir(dir)).toEqual([]);
});
