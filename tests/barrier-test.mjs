import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test } from "vite-plus/test";
import { createBodyBarrier } from "./runtime-helpers.mjs";

/**
 * Returns a `test` that runs every body through a body barrier, for a file whose tests spy on
 * `console.error` or read `process.exitCode`. Vitest lets a body that passed its timeout keep
 * running, so its late cleanup would clear the spy calls or the exit code of the next test
 * (issue #943, after #935). A `beforeEach` hook registered here waits for every earlier body to end,
 * and the wait outlasts `testTimeout`.
 *
 * Call it once at the top of the file, before any other hook, so the wait runs first. The result
 * accepts the `test(name, fn, options)`, `test.each(table)(...)`, and `test.skipIf(cond)(...)` forms.
 * Side effect: registers one pair of tests that fails when a file does not wait for a timed-out body.
 */
export function createBarrierTest() {
  const barrier = createBodyBarrier();
  beforeEach(() => barrier.settled(), 60_000);
  const guard = (args) =>
    args.map((arg) => (typeof arg === "function" ? (...a) => barrier.run(() => arg(...a)) : arg));
  const guarded = (name, ...rest) => test(name, ...guard(rest));
  guarded.each =
    (table) =>
    (name, ...rest) =>
      test.each(table)(name, ...guard(rest));
  guarded.skipIf =
    (condition) =>
    (name, ...rest) =>
      test.skipIf(condition)(name, ...guard(rest));

  let lateCleanupDone = false;
  // Usefulness: sets up the leak that the next test checks, a body that outlives its own timeout.
  // `fails` expects the timeout, so only an unexpected pass or error shows in the report.
  test.fails(
    "a body past its timeout keeps running",
    { timeout: 20 },
    ...guard([
      async () => {
        await delay(200);
        lateCleanupDone = true;
      },
    ]),
  );
  // Usefulness: verifies that this file starts a test only after an earlier timed-out body ended,
  // so its late cleanup cannot change the spy calls or the exit code that the test reads.
  guarded("a test starts after an earlier timed-out body has ended", () => {
    expect(lateCleanupDone).toBe(true);
  });
  return guarded;
}
