import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readLockOwner, tryStateLock, withStateLock } from "../../src/lib/state-lock.mjs";
import { removePath, trackedTempDir } from "../fs-helpers.mjs";

// A partial module mock keeps the real filesystem and lets a test count the directory listings.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readdir: vi.fn(real.readdir) };
});

let dirs = [];

afterEach(async () => {
  vi.mocked(readdir).mockClear();
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

// Usefulness: verifies one acquisition lists the lock directory once, where the temp prune and the
// orphan-claim prune each listed it before, so every poll of a waiting wrapper costs one listing.
test("one acquisition lists the lock directory once", async () => {
  const dir = await trackedTempDir("runstate-poll-", dirs);
  const lockFile = join(dir, "state.lock");

  await withStateLock(lockFile, async () => {});

  expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === dir)).toHaveLength(1);
});

// Usefulness: verifies the release function of `tryStateLock` carries the nonce that the lock file
// holds, so a caller learns its own nonce without reading the lock back.
test("tryStateLock exposes the nonce of the lock it wrote", async () => {
  const dir = await trackedTempDir("runstate-poll-", dirs);
  const lockFile = join(dir, "state.lock");

  const release = await tryStateLock(lockFile);

  expect(typeof release.nonce).toBe("string");
  expect((await readLockOwner(lockFile)).nonce).toBe(release.nonce);
  await release();
});
