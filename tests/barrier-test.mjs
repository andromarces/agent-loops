import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, expect, test } from "vite-plus/test";
import { createBodyBarrier } from "./runtime-helpers.mjs";

// `process.exitCode` is a non-configurable accessor, so a write cannot be hooked on `process`. The
// global `process` becomes a forwarding proxy that drops an exit code write made from the async
// context of a body whose test already ended (timeout or abort). A hook or test body of the caller
// runs outside that context, so its writes, deliberate failure codes included, are kept.
// known-limit: `import process from "node:process"` bypasses the proxy.
const bodyOfTest = new AsyncLocalStorage();
globalThis.process = new Proxy(process, {
  get: (target, key) => Reflect.get(target, key, target),
  set: (target, key, value) =>
    (key === "exitCode" && bodyOfTest.getStore()?.aborted) ||
    Reflect.set(target, key, value, target),
});

/**
 * Returns a `test` that runs every body through a body barrier, for a file whose tests spy on
 * `console.error` or read `process.exitCode`. Vitest lets a body that passed its timeout keep
 * running, so its late cleanup would clear the spy calls or the exit code of the next test
 * (issue #943, after #935). A `beforeEach` hook registered here waits for every earlier body to end,
 * and the wait outlasts `testTimeout`. A write to `process.exitCode` by a body after its test ended
 * is dropped, so a late body cannot change the exit code that the next test reads, while a code that
 * a test set on purpose stays. A barrier wait that reaches its bound names the hung test.
 *
 * Call it once at the top of the file, before any other hook, so the wait runs first. The result
 * accepts the `test(name, fn, options)`, `test.each(table)(...)`, and `test.skipIf(cond)(...)` forms.
 * Side effect: registers one pair of tests that fails when a file does not wait for a timed-out body.
 */
export function createBarrierTest({ barrier = createBodyBarrier() } = {}) {
  let lateBodyStarted = false;
  let lateCleanupDone = false;
  let doneWhenTestStarted = false;
  let signal;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  beforeEach(async (context) => {
    // The late body of the regression pair ends only after this hook opens its gate, so the
    // body cannot end earlier, however long a hook or teardown of the file takes.
    if (lateBodyStarted) openGate();
    await barrier.settled();
    signal = context.signal;
    doneWhenTestStarted = lateCleanupDone;
  }, 60_000);
  // The title comes from the running test, so a `test.each` case is named by its own title.
  const guard = (args) =>
    args.map((arg) =>
      typeof arg === "function"
        ? (...a) =>
            barrier.run(
              () => bodyOfTest.run(signal, () => arg(...a)),
              expect.getState().currentTestName,
            )
        : arg,
    );
  const guarded = (name, ...rest) => test(name, ...guard(rest));
  guarded.each =
    (table) =>
    (name, ...rest) =>
      test.each(table)(name, ...guard(rest));
  guarded.skipIf =
    (condition) =>
    (name, ...rest) =>
      test.skipIf(condition)(name, ...guard(rest));
  guarded.fails = (name, ...rest) => test.fails(name, ...guard(rest));

  // Usefulness: sets up the leak that the next test checks, a body that outlives its own timeout.
  // `fails` expects the timeout, so only an unexpected pass or error shows in the report.
  guarded.fails("a body past its timeout keeps running", { timeout: 20 }, async () => {
    lateBodyStarted = true;
    await gate;
    await delay(10);
    lateCleanupDone = true;
  });
  // Usefulness: verifies that this file starts a test only after an earlier timed-out body ended,
  // so its late cleanup cannot change the spy calls or the exit code that the test reads. The late
  // body ends a timer tick after the hook of this test opens its gate, and the hook reads the state
  // as the wait returns, so only the wait can make the state true.
  guarded("a test starts after an earlier timed-out body has ended", () => {
    expect(doneWhenTestStarted).toBe(true);
  });
  return guarded;
}
