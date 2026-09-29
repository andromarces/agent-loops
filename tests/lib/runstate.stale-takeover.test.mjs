import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock } from "../../src/lib/runstate.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";

// The stale-lock race needs a second process to act between the owner read and
// the removal, which real timing cannot reproduce on demand. `readFile` is
// wrapped so the interleaving runs right after the contender reads the lock. The
// mock applies to the whole module, so the real-filesystem cases stay in
// runstate.test.mjs (#363).
const realFs = await vi.importActual("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: vi.fn(async (...args) => await realFs.readFile(...args)),
}));

let dirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "runstate-takeover-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(readFile)
    .mockReset()
    .mockImplementation(async (...a) => await realFs.readFile(...a));
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

/** Runs `interleave` once, right after the first read of `lockFile` returns. */
function afterLockRead(lockFile, interleave) {
  vi.mocked(readFile).mockImplementationOnce(async (file, ...rest) => {
    const text = await realFs.readFile(file, ...rest);
    if (file === lockFile) {
      await interleave();
    }
    return text;
  });
}

// Usefulness: verifies a stale takeover never removes a lock that another
// process created after the stale owner was read. Removing it would let two
// processes run inside the state lock at once (#363).
test("stale removal leaves a lock that a new owner created after the read", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const liveOwner = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" });
  await writeFile(lockFile, JSON.stringify({ pid: await deadPid(), startedAt: "old" }), "utf8");
  afterLockRead(lockFile, async () => {
    await rm(lockFile);
    await writeFile(lockFile, liveOwner, "utf8");
  });
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe(liveOwner);
  expect(await readdir(dir)).toEqual(["state.lock"]);
});

// Usefulness: verifies the stale removal still succeeds when another contender
// already removed the same stale lock, so the single retry acquires it (#363).
test("stale removal proceeds when another contender already removed the lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, JSON.stringify({ pid: await deadPid(), startedAt: "old" }), "utf8");
  afterLockRead(lockFile, async () => {
    await rm(lockFile);
  });

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});
