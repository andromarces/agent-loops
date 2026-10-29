import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const hashing = vi.hoisted(() => ({ stall: false, failing: new Set() }));
vi.mock("../../src/lib/snapshot.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sha256File: (path) => {
      if (hashing.stall) return new Promise(() => {});
      if ([...hashing.failing].some((name) => path.endsWith(name))) {
        return Promise.reject(Object.assign(new Error(`busy: ${path}`), { code: "EBUSY" }));
      }
      return actual.sha256File(path);
    },
  };
});

const { diffLockfiles, readLockfiles } = await import("../../src/lib/lockfile-change.mjs");

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  hashing.stall = false;
  hashing.failing.clear();
  vi.restoreAllMocks();
  await removePath(repo);
});

// Usefulness: verifies requirement "a stalled lockfile read ends at the bound" (issue #1180): a hang
// would hold the worker turn after a cancel. A lockfile whose hash did not end in time is reported,
// never read as absent.
test("a stalled lockfile hash read ends at the bound and reports every lockfile", async () => {
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.stall = true;
  const started = Date.now();
  const after = await readLockfiles(repo, { boundMs: 2_000 });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(diffLockfiles(before, after)).toContain("pnpm-lock.yaml");
  expect(warn.mock.calls.some((call) => String(call[0]).includes("lockfile"))).toBe(true);
});

// Usefulness: verifies requirement "a lockfile that cannot be read is reported as changed" (issue
// #1180): the parent reads only the envelope, so a warning alone would leave an edited lockfile with
// no reinstall signal. A reinstall is harmless and a missed one is the failure the field targets.
test("an edited lockfile whose hash read fails is still reported", async () => {
  const before = await readLockfiles(repo);
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  hashing.failing.add("pnpm-lock.yaml");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const after = await readLockfiles(repo);
  expect(diffLockfiles(before, after)).toEqual(["pnpm-lock.yaml"]);
  expect(warn.mock.calls.some((call) => String(call[0]).includes("EBUSY"))).toBe(true);
});

// Usefulness: verifies the same when the read before the turn failed, so a lockfile with an unknown
// start state is reported too.
test("a lockfile whose hash read failed before the turn is reported", async () => {
  hashing.failing.add("pnpm-lock.yaml");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const before = await readLockfiles(repo);
  hashing.failing.clear();
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  expect(diffLockfiles(before, await readLockfiles(repo))).toEqual(["pnpm-lock.yaml"]);
});

// Usefulness: verifies an unread lockfile state is never compared, so a failed read reports no change.
test("two lockfile reads that failed report no change", () => {
  expect(diffLockfiles(null, null)).toEqual([]);
});
