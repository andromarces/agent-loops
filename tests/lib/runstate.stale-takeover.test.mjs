import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** Ages a file far past the grace window, so an unparseable lock counts as stale. */
async function ageFile(file) {
  await utimes(file, new Date(0), new Date(0));
}

/**
 * Learns, by watching the hard links a takeover attempts, the path of the first
 * claim it takes that is not already `planted` (a list of `[path, text]`). The
 * claim name is keyed by the stale content, so the same stale lock always yields
 * the same path. Leaves the directory empty.
 */
async function learnNextClaim(lockFile, stale, planted, { aged = false } = {}) {
  const attempted = [];
  vi.mocked(link).mockImplementation(async (from, to) => {
    attempted.push(to);
    return await realFs.link(from, to);
  });
  await writeFile(lockFile, stale, "utf8");
  if (aged) {
    await ageFile(lockFile);
  }
  for (const [path, text] of planted) {
    await writeFile(path, text, "utf8");
  }
  await withStateLock(lockFile, async () => "ran").catch(() => {});
  vi.mocked(link).mockImplementation(async (...a) => await realFs.link(...a));
  for (const name of await readdir(dirname(lockFile))) {
    await rm(join(dirname(lockFile), name), { force: true });
  }
  return attempted.find((to) => to !== lockFile && !planted.some(([path]) => path === to));
}

/** Writes `stale` as the lock, guarded by `length` dead claims, and returns the first claim path. */
async function writeDeadClaims(lockFile, stale, length) {
  const planted = [];
  for (let i = 0; i < length; i += 1) {
    planted.push([await learnNextClaim(lockFile, stale, planted), await staleOwner()]);
  }
  await writeFile(lockFile, stale, "utf8");
  for (const [path, text] of planted) {
    await writeFile(path, text, "utf8");
  }
  return planted[0][0];
}

/** The lock a second process creates once the stale owner was read. */
async function replaceWithLiveLock(lockFile) {
  await rm(lockFile);
  await writeFile(lockFile, LIVE_OWNER, "utf8");
}

// Usefulness: verifies a stale takeover never removes a lock that another process created after the stale owner was read. Removing it would let two processes run inside the state lock at once (#363).
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

// Usefulness: verifies the stale removal still succeeds when another contender already removed the same stale lock, so the single retry acquires it (#363).
test("stale removal proceeds when another contender already removed the lock", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, await staleOwner(), "utf8");
  afterLockRead(lockFile, () => rm(lockFile));

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a new owner that releases its lock while the stale removal is under way leaves no phantom lock: the contender acquires the released lock, and the lock path is never restored for an owner that is gone (#363).
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

// Usefulness: verifies a failed re-read of the lock during the stale removal keeps a new owner's live lock and leaks no file: an unreadable lock is never treated as the stale one (#363).
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

// Usefulness: verifies a stale-removal claim left by a crashed process (dead pid) does not block later takeovers of a stale lock (#363).
test("a dead process's stale-removal claim is taken over", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeDeadClaims(lockFile, await staleOwner(), 1);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a stale lock is left in place while a live process holds the stale-removal claim, so two contenders never remove it at once (#363).
test("a live process's stale-removal claim blocks the takeover", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const stale = await staleOwner();
  const claimFile = await learnNextClaim(lockFile, stale, []);
  await writeFile(lockFile, stale, "utf8");
  await writeFile(claimFile, LIVE_OWNER, "utf8");
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe(stale);
});

// Usefulness: verifies two contenders never both act as reaper after a dead claim: the one that loses the takeover exits as busy and never removes the live lock a new owner creates (#363).
test("a dead claim that another contender took over is not taken over again", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const stale = await staleOwner();
  const claimFile = await writeDeadClaims(lockFile, stale, 1);
  let claimTaken = false;
  let lockReplaced = false;
  vi.mocked(readFile).mockImplementation(async (file, ...rest) => {
    const text = await realFs.readFile(file, ...rest);
    if (file === claimFile && !claimTaken) {
      // Another contender takes over the dead claim right after this one read it.
      claimTaken = true;
      await rm(claimFile);
      await writeFile(claimFile, LIVE_OWNER, "utf8");
    } else if (file === lockFile && claimTaken && !lockReplaced) {
      // That contender finishes: the stale lock goes and a new owner takes its place.
      lockReplaced = true;
      await replaceWithLiveLock(lockFile);
    }
    return text;
  });
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

  expect(fn).not.toHaveBeenCalled();
  expect([stale, LIVE_OWNER]).toContain(await realFs.readFile(lockFile, "utf8"));
  expect((await readdir(dir)).sort()).toEqual(["state.lock", basename(claimFile)]);
});

// Usefulness: verifies a dead claim that guards another dead claim is removed through its own claim, so a takeover still succeeds after two crashed processes (#363).
test("a chain of dead claims is removed and the lock is acquired", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeDeadClaims(lockFile, await staleOwner(), 2);

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");

  expect(await readdir(dir)).toEqual([]);
});

// Usefulness: verifies a chain of dead claims deeper than the bound fails closed and leaves the stale lock in place instead of looping (#363).
test("a chain of dead claims deeper than the bound fails closed", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeDeadClaims(lockFile, await staleOwner(), 3);
  const before = await readdir(dir);
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/nested too deep/);

  expect(fn).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual(before);
});

// Usefulness: verifies a new owner whose pid and start time equal the stale owner's is not mistaken for the stale lock and removed, because each acquisition writes distinct content (#363).
test("a new owner with the stale owner's pid and start time survives the takeover", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = new Date().toISOString();
  const stale = JSON.stringify({ pid: process.pid, startedAt });
  await writeFile(lockFile, stale, "utf8");
  // The stale owner's pid reads dead once, then belongs to a live process again.
  const kill = vi.spyOn(process, "kill");
  kill.mockImplementationOnce(() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let holder;
  afterLockRead(lockFile, async () => {
    await rm(lockFile);
    holder = withStateLock(lockFile, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
  });
  const fn = vi.fn(async () => "ran");

  try {
    await expect(withStateLock(lockFile, fn)).rejects.toThrow(/locked by a live process/);

    expect(fn).not.toHaveBeenCalled();
    const held = await realFs.readFile(lockFile, "utf8");
    expect(JSON.parse(held)).toMatchObject({ pid: process.pid, startedAt });
    expect(held).not.toBe(stale);
  } finally {
    release.resolve();
    await holder;
    kill.mockRestore();
    vi.useRealTimers();
  }
});

// Usefulness: verifies a stale lock whose content is the text "null" and a stale lock with other unparseable content are guarded by different claims, so a live claim on one never blocks the takeover of the other (#363).
test("stale locks with distinct content do not share a claim", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const nullClaim = await learnNextClaim(lockFile, "null", [], { aged: true });
  await writeFile(lockFile, "unreadable", "utf8");
  await ageFile(lockFile);
  await writeFile(nullClaim, LIVE_OWNER, "utf8");

  await expect(withStateLock(lockFile, async () => "ran")).resolves.toBe("ran");
});

// Usefulness: verifies a lock that cannot be read is never taken over, because its owner cannot be identified, so the contender exits as busy and removes nothing (#452).
test("a lock that cannot be read is not taken over", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  await writeFile(lockFile, "unreadable", "utf8");
  vi.mocked(readFile).mockImplementation(async (file, ...rest) => {
    if (file === lockFile) {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return await realFs.readFile(file, ...rest);
  });
  const fn = vi.fn(async () => "ran");

  await expect(withStateLock(lockFile, fn)).rejects.toThrow(/not readable yet/);

  expect(fn).not.toHaveBeenCalled();
  expect(await realFs.readFile(lockFile, "utf8")).toBe("unreadable");
});

// Usefulness: verifies the claim name for a given stale lock never changes across versions, so a claim that an earlier version wrote is still found and honored (#446).
test("the claim file name for a stale lock is stable across versions", async () => {
  const dir = await tempDir();
  const lockFile = join(dir, "state.lock");
  const stale = JSON.stringify({ pid: 999999999, startedAt: "old" });

  const claimFile = await learnNextClaim(lockFile, stale, []);

  expect(basename(claimFile)).toBe(
    "state.lock.reap.88057746166664f02d34a2d246009f3d041890d2411f13b2ed48b9a9db7a4fdc",
  );
});
