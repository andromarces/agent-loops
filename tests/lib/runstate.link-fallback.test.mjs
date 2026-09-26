import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { withStateLock } from "../../src/lib/runstate.mjs";

// A filesystem without hard links (FAT/exFAT, some network mounts) makes every
// `link` fail. Linux vfat reports EPERM and macOS reports ENOTSUP; Windows
// maps the CreateHardLinkW ERROR_INVALID_FUNCTION on FAT/exFAT to EISDIR
// (nodejs/node#65817). A partial module mock keeps the real filesystem for
// every other call; this file exists separately because the mock applies to the
// whole module and would break the real-fs cases in runstate.test.mjs (#178).
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
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
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
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
