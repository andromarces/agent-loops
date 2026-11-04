import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  START_TIME_CACHE_MAX_AGE_MS,
  ownerAlive,
  startTimeCache,
} from "../../src/lib/process-identity.mjs";

// Every test drives a counted probe, so none spawns `ps` or PowerShell and none sleeps.
afterEach(() => {
  vi.restoreAllMocks();
});

const LIVE_STAMP = "darwin-lstart:1000";
const REUSED_STAMP = "darwin-lstart:9000";

// Usefulness: acceptance (#1404) — several wait passes over one live owner start the
// start-time probe once. Not redundant: no other test counts probes across passes.
test("several passes on one live owner start the start-time probe once", async () => {
  const probe = vi.fn(async () => LIVE_STAMP);
  const cache = startTimeCache({ probe });
  const owner = { pid: process.pid, startTime: LIVE_STAMP };

  for (let pass = 0; pass < 5; pass++) {
    await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  }
  expect(probe).toHaveBeenCalledTimes(1);
});

// Usefulness: acceptance (#1404) — a pid reused between passes keeps `pidAlive` true, so
// the entry age must re-probe and free the slot. Not redundant: only this test covers reuse.
test("a pid reused after the cache age frees the slot", async () => {
  let elapsed = 0;
  let stamp = LIVE_STAMP;
  const probe = vi.fn(async () => stamp);
  const cache = startTimeCache({ probe, monotonic: () => elapsed });
  const owner = { pid: process.pid, startTime: LIVE_STAMP };

  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  expect(probe).toHaveBeenCalledTimes(1);

  stamp = REUSED_STAMP;
  elapsed += START_TIME_CACHE_MAX_AGE_MS;
  await expect(ownerAlive(owner, cache)).resolves.toBe(false);
  expect(probe).toHaveBeenCalledTimes(2);
});

// Usefulness: acceptance (#1404) — a dead owner frees the slot on the next pass and its
// cache entry is gone. Not redundant: only this test observes the drop on a dead pid.
test("a dead owner is freed at once and its cache entry is dropped", async () => {
  const probe = vi.fn(async () => LIVE_STAMP);
  const cache = startTimeCache({ probe });
  const owner = { pid: process.pid, startTime: LIVE_STAMP };

  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  });
  await expect(ownerAlive(owner, cache)).resolves.toBe(false);
  expect(probe).toHaveBeenCalledTimes(1);

  kill.mockRestore();
  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});

// Usefulness: acceptance (#1404) — a new holder with another pid or recorded start time
// gets its own probe. Not redundant: no other test keys the cache by both fields.
test("a new holder with another pid or recorded start time gets its own entry", async () => {
  const probe = vi.fn(async (pid) => `darwin-lstart:${pid}`);
  const cache = startTimeCache({ probe });

  await expect(
    ownerAlive({ pid: process.pid, startTime: `darwin-lstart:${process.pid}` }, cache),
  ).resolves.toBe(true);
  await expect(
    ownerAlive({ pid: process.pid, startTime: `darwin-lstart:${process.pid + 5000}` }, cache),
  ).resolves.toBe(false);
  await expect(
    ownerAlive({ pid: process.ppid, startTime: `darwin-lstart:${process.ppid}` }, cache),
  ).resolves.toBe(true);
  expect(probe).toHaveBeenCalledTimes(3);
});

// Usefulness: acceptance (#1404) — a failed or unknown probe is not cached, so a later
// pass uses a recovered source. Not redundant: only this test covers the null result.
test("a failed or unknown probe result is not cached", async () => {
  let stamp = null;
  const probe = vi.fn(async () => stamp);
  const cache = startTimeCache({ probe });
  const owner = { pid: process.pid, startTime: LIVE_STAMP };

  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  stamp = LIVE_STAMP;
  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
});

// Usefulness: review (#1404) — a 60 s wall-clock rollback must not extend a cached entry
// past its age. Not redundant: only this test separates wall time from monotonic age.
test("a wall-clock step backward does not extend a cached entry", async () => {
  let wall = 1_000_000;
  let elapsed = 0;
  let stamp = LIVE_STAMP;
  const probe = vi.fn(async () => stamp);
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const cache = startTimeCache({ probe, monotonic: () => elapsed });
  const owner = { pid: process.pid, startTime: LIVE_STAMP };

  await expect(ownerAlive(owner, cache)).resolves.toBe(true);
  expect(probe).toHaveBeenCalledTimes(1);

  stamp = REUSED_STAMP;
  wall -= 60_000;
  elapsed += START_TIME_CACHE_MAX_AGE_MS;
  await expect(ownerAlive(owner, cache)).resolves.toBe(false);
  expect(probe).toHaveBeenCalledTimes(2);
});
