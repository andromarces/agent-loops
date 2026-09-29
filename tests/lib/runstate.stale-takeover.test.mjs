import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock } from "../../src/lib/runstate.mjs";
import { deadPid, removePath } from "../runtime-helpers.mjs";

// The stale-lock race needs a second process to act between the owner read and
// the removal, which real timing cannot reproduce on demand. `readFile` and
// `link` are wrapped so the interleaving runs right after the contender reads
// the lock. The mock applies to the whole module, so the real-filesystem cases
// stay in runstate.test.mjs (#363).
const realFs = await vi.importActual("node:fs/promises");

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  readFile: vi.fn(async (...args) => await realFs.readFile(...args)),
  link: vi.fn(async (...args) => await realFs.link(...args)),
}));

const { readFile, link } = await import("node:fs/promises");

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
  vi.mocked(link)
    .mockReset()
    .mockImplementation(async (...a) => await realFs.link(...a));
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
});

const LIVE_OWNER = JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" });

async function staleOwner() {
  return JSON.stringify({ pid: await deadPid(), startedAt: "old" });
}

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

/** The lock a second process creates once the stale owner was read. */
async function replaceWithLiveLock(lockFile) {
  await rm(lockFile);
  await writeFile(lockFile, LIVE_OWNER, "utf8");
}

// Usefulness: verifies a stale takeover never removes a lock that another
// process created after the stale owner was read. Removing it would let two
// processes run inside the state lock at once (#363).
test("stale removal leaves a lock that a new owner created after the read", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  afterLockRead(lockFile, () => replaceWithLiveLock(lockFile));
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe(LIVE_OWNER);
  expect(await readdir(dir)).toEqual(["state.lock"]);
});

// Usefulness: verifies the stale removal still succeeds when another contender
// already removed the same stale lock, so the single retry acquires it (#363).
test("stale removal proceeds when another contender already removed the lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  afterLockRead(lockFile, () => rm(lockFile));

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a new owner that releases its lock while the stale
// removal is under way leaves no phantom lock: the contender acquires the
// released lock, and the lock path is never restored for an owner that is gone
// (#363).
test("a new owner that releases during the stale removal leaves no lock behind", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  afterLockRead(lockFile, async () => {
    await replaceWithLiveLock(lockFile);
    // The new owner releases at the contender's next link, the first step after
    // the read that touches the lock path.
    vi.mocked(link).mockImplementationOnce(async (...args) => {
      await rm(lockFile, { force: true });
      return await realFs.link(...args);
    });
  });

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a failed re-read of the lock during the stale removal
// keeps a new owner's live lock and leaks no file: an unreadable lock is never
// treated as the stale one (#363).
test("a lock that cannot be re-read during stale removal is kept", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  afterLockRead(lockFile, async () => {
    await replaceWithLiveLock(lockFile);
    vi.mocked(readFile).mockImplementationOnce(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
  });
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe(LIVE_OWNER);
  expect(await readdir(dir)).toEqual(["state.lock"]);
});

// Usefulness: verifies a stale-removal claim left by a crashed process (dead
// pid) does not block later takeovers of a stale lock (#363).
test("a dead process's stale-removal claim is taken over", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  await writeFile(`${lockFile}.reap`, await staleOwner(), "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a stale lock is left in place while a live process holds
// the stale-removal claim, so two contenders never remove it at once (#363).
test("a live process's stale-removal claim blocks the takeover", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const stale = await staleOwner();
  await writeFile(lockFile, stale, "utf8");
  await writeFile(`${lockFile}.reap`, LIVE_OWNER, "utf8");
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe(stale);
});
