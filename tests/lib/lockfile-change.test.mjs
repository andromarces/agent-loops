import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const hashing = vi.hoisted(() => ({ stall: false }));
vi.mock("../../src/lib/snapshot.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sha256File: (path) => (hashing.stall ? new Promise(() => {}) : actual.sha256File(path)),
  };
});

const { diffLockfiles, readLockfiles } = await import("../../src/lib/lockfile-change.mjs");

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  hashing.stall = false;
  vi.restoreAllMocks();
  await removePath(repo);
});

// Usefulness: verifies requirement "a stalled lockfile read ends at the bound" (issue #1180): a hang
// would hold the worker turn after a cancel, and a read that reported every lockfile absent would
// read as a change.
test("a stalled lockfile hash read ends at the bound with no result and a warning", async () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.stall = true;
  const started = Date.now();
  expect(await readLockfiles(repo, { boundMs: 50 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(warn.mock.calls.some((call) => String(call[0]).includes("lockfile"))).toBe(true);
});

// Usefulness: verifies an unread lockfile state is never compared, so a failed read reports no change.
test("two lockfile reads that failed report no change", () => {
  expect(diffLockfiles(null, null)).toEqual([]);
});
