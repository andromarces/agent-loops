import { setTimeout as delay } from "node:timers/promises";

/**
 * Rejects when `promise` has not settled within `ms`, so a hung process fails its test with
 * `label` instead of holding the suite until the test timeout.
 */
export async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls `probe` until it returns a value other than `undefined`. Rejects at one absolute deadline
 * of `ms` on a monotonic clock. Each probe races the time that remains, so a probe that never
 * settles cannot hold the wait past the deadline, and slow I/O or timer delay cannot stretch it.
 * A result counts only when the probe settled at or before the deadline: a result that arrives
 * later, even before the timer callback runs, is rejected, and a late settle is ignored.
 * @returns {Promise<unknown>} the first value that is not `undefined`
 */
export async function pollUntil(probe, ms) {
  const deadline = performance.now() + ms;
  const expired = Symbol("expired");
  for (;;) {
    const pending = Promise.resolve()
      .then(probe)
      .then((value) => ({ value, at: performance.now() }));
    // A late failure of an abandoned probe must not become an unhandled rejection.
    pending.catch(() => {});
    let timer;
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - performance.now()), expired);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result === expired || result.at > deadline) {
      throw new Error(`The condition was not met within ${ms} ms.`);
    }
    if (result.value !== undefined) {
      return result.value;
    }
    if (performance.now() >= deadline) {
      throw new Error(`The condition was not met within ${ms} ms.`);
    }
    await delay(Math.min(25, Math.max(0, deadline - performance.now())));
  }
}
