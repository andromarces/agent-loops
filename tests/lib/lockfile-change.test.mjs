import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { removePath } from "../fs-helpers.mjs";
import { createTempRepo } from "../git-helpers.mjs";

const hashing = vi.hoisted(() => ({
  stall: false,
  failing: new Set(),
  captureSignal: false,
  signals: [],
}));
vi.mock("../../src/lib/snapshot.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sha256File: (path, options) => {
      if (hashing.captureSignal) {
        hashing.signals.push(options?.signal);
        return new Promise(() => {});
      }
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
  hashing.captureSignal = false;
  hashing.signals.length = 0;
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

// Usefulness: verifies requirement "the bound aborts the signal of a hash read" (issue #1225), so a
// read that has not started its request stops. It shows the signal, not release of an open handle.
test("a hash read still pending at the bound receives an aborted signal", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.captureSignal = true;
  await readLockfiles(repo, { boundMs: 200 });
  expect(hashing.signals.length).toBeGreaterThan(0);
  expect(hashing.signals.every((signal) => signal?.aborted === true)).toBe(true);
});

// Usefulness: verifies requirement "the bound aborts with its named reason" (#1269): the helper
// shared by three reads must not change the lockfile read's abort reason.
test("the bound aborts a pending hash read with the lockfile read reason", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  hashing.captureSignal = true;
  await readLockfiles(repo, { boundMs: 200 });
  const reason = hashing.signals[0].reason;
  expect(reason).toBeInstanceOf(Error);
  expect(reason.message).toBe("lockfile read took over 200 ms");
});

// Usefulness: verifies requirement "an unread work tree root reaches the parent" (issue #1225): the
// parent reads only the envelope, so a null read would look like "no change". An unread root counts
// as changed for every lockfile, like an unreadable lockfile.
test("an unread work tree root reports every lockfile as changed", async () => {
  const before = await readLockfiles(repo);
  const outside = await mkdtemp(join(tmpdir(), "agent-loops-no-repo-"));
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const after = await readLockfiles(outside);
    expect(after).not.toBeNull();
    expect(diffLockfiles(before, after)).toEqual([
      "bun.lock",
      "bun.lockb",
      "npm-shrinkwrap.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("lockfile"))).toBe(true);
  } finally {
    await removePath(outside);
  }
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
