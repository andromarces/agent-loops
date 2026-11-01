import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createBodyBarrier } from "./body-barrier.mjs";

describe("createBodyBarrier", () => {
  const barrier = createBodyBarrier();
  let lateCleanupDone = false;
  beforeEach(() => barrier.settled());

  // Usefulness: sets up the leak that the next test checks, a body that outlives its own timeout.
  // `fails` expects the timeout, so only an unexpected pass or error shows in the report.
  test.fails("a body past its timeout keeps running", { timeout: 20 }, () =>
    barrier.run(async () => {
      await delay(200);
      lateCleanupDone = true;
    }),
  );

  // Usefulness: verifies that a test starts only after an earlier timed-out body ended, so its late
  // cleanup cannot change the spy calls or the exit code that this test reads (issue #935).
  test("a test starts after an earlier timed-out body has ended", () => {
    expect(lateCleanupDone).toBe(true);
  });
});

describe("createBodyBarrier with a body that never ends", () => {
  const WAIT_MS = 60_000;
  const hang = () => new Promise(() => {});
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  // Usefulness: acceptance (#942) — the first wait ends at its bound and the error names the hung
  // body, so the failed test shows which body blocked it.
  test("the first wait fails at its bound and names the hung body", async () => {
    const barrier = createBodyBarrier({ waitMs: WAIT_MS });
    barrier.run(hang, "hung body");
    const outcome = barrier.settled().then(
      () => undefined,
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect((await outcome)?.message).toMatch(/hung body/);
  });

  // Usefulness: acceptance (#942) — a later wait for the same body fails at once and names it, so one
  // hung body costs one bound across the suite. With fake timers no time passes, so a second wait
  // would never settle.
  test("a later wait fails at once and names the abandoned body", async () => {
    const barrier = createBodyBarrier({ waitMs: WAIT_MS });
    barrier.run(hang, "hung body");
    const first = barrier.settled().catch(() => {});
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    await first;
    await expect(barrier.settled()).rejects.toThrow(/hung body/);
    await expect(barrier.settled()).rejects.toThrow(/hung body/);
  });

  // Usefulness: acceptance (#942) — the guarantee of #935 holds again once the abandoned body ends,
  // so a late finish does not fail the rest of the suite.
  test("waits succeed again after the abandoned body ends", async () => {
    const barrier = createBodyBarrier({ waitMs: WAIT_MS });
    let finish;
    const body = barrier.run(() => new Promise((resolve) => (finish = resolve)), "late body");
    const first = barrier.settled().catch(() => {});
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    await first;
    finish();
    await body;
    await expect(barrier.settled()).resolves.toBeUndefined();
  });
});
