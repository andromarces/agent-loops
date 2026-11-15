import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, describe, expect, test } from "vite-plus/test";

/**
 * Tracks the bodies of tests that change process-wide state, such as a `console.error` spy or
 * `process.exitCode`. Vitest lets a body past its timeout keep running, so its late cleanup can
 * land inside the next test. `run(body)` registers a body, and `settled()` resolves when every
 * registered body has ended, fulfilled or rejected. Call `settled()` from a `beforeEach` hook, so
 * no test starts while an earlier body still runs.
 *
 * One wait lasts at most `waitMs`, and a wait that reaches it abandons the bodies still running
 * and rejects naming them. Every later `settled()` rejects at once with the same names until the
 * body ends, so one hung body costs one wait, and waits work again.
 */
// The default 50 s stays under the 60 s hook timeout of the callers.
export function createBodyBarrier({ waitMs = 50_000 } = {}) {
  const running = new Map();
  const abandoned = new Set();
  const hung = () =>
    [...abandoned].map((promise) => running.get(promise)).join(", ") || "an unnamed body";
  const failure = () =>
    new Error(
      `The test body "${hung()}" did not end within ${waitMs} ms, so this test cannot start without risking its spy and exit code.`,
    );
  return {
    // `name` labels a body in errors, and the body function name is the default.
    run(body, name = body.name || "anonymous body") {
      const promise = (async () => body())();
      const forget = () => {
        running.delete(promise);
        abandoned.delete(promise);
      };
      running.set(promise, name);
      promise.then(forget, forget);
      return promise;
    },
    async settled() {
      if (abandoned.size > 0) throw failure();
      const expired = Symbol("expired");
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs, expired);
      });
      try {
        while (running.size > 0) {
          const ended = await Promise.race([Promise.allSettled(running.keys()), deadline]);
          if (ended === expired) {
            for (const promise of running.keys()) abandoned.add(promise);
            throw failure();
          }
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Returns a `test` that runs every body through a body barrier, for a file whose tests spy on
 * `console.error` or read `process.exitCode`. Vitest lets a body that passed its timeout keep
 * running, so its late cleanup would clear the spy calls or the exit code of the next test
 * (issue #943, after #935). A `beforeEach` hook registered here waits for every earlier body to end,
 * and the wait outlasts `testTimeout`. When a body ended after its test did, the hook then resets
 * `process.exitCode` to the code that the process had when this function ran, so a late body cannot
 * change the exit code that the next test reads. Without a late body, the code is left as it is, so
 * a code that a test set on purpose stays. A barrier wait that reaches its bound names the hung test.
 *
 * Call it once at the top of the file, before any other hook, so the wait runs first. The result
 * accepts the `test(name, fn, options)`, `test.each(table)(...)`, and `test.skipIf(cond)(...)` forms.
 * Side effect: registers one pair of tests, in a fixed order, that fails when a file does not wait
 * for a timed-out body.
 */
export function createBarrierTest({ barrier = createBodyBarrier() } = {}) {
  let lateBodyStarted = false;
  let lateCleanupDone = false;
  let doneWhenTestStarted = false;
  const startExitCode = process.exitCode;
  let signal;
  let lateBodyEnded = false;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  beforeEach(async (context) => {
    // The late body of the regression pair ends only after this hook opens its gate, so the
    // body cannot end earlier, however long a hook or teardown of the file takes.
    if (lateBodyStarted) openGate();
    await barrier.settled();
    if (lateBodyEnded) process.exitCode = startExitCode;
    lateBodyEnded = false;
    signal = context.signal;
    doneWhenTestStarted = lateCleanupDone;
  }, 60_000);
  // The title comes from the running test, so a `test.each` case is named by its own title.
  const guard = (args) =>
    args.map((arg) =>
      typeof arg === "function"
        ? (...a) => {
            const testSignal = signal;
            const body = async () => {
              try {
                return await arg(...a);
              } finally {
                if (testSignal?.aborted) lateBodyEnded = true;
              }
            };
            return barrier.run(body, expect.getState().currentTestName);
          }
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

  // The second test reads what the first test sets up, so the pair keeps its order under shuffle.
  // The `shuffle: false` option on this suite overrides the file-wide shuffle (Vitest 5.1.0).
  describe("the barrier regression pair", { shuffle: false }, () => {
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
  });
  return guarded;
}
