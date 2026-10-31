/**
 * Runs `run({ signal, stopped })` under a time bound of `boundMs`. At the bound, `signal` aborts
 * with `new Error(message)`, and `stopped` rejects with the same error, so `Promise.race([call,
 * stopped])` ends the wait for a call that cannot be canceled. The timer is unref'd, so a pending
 * read never keeps the process alive, and it is cleared when `run` settles. `stopped` has a
 * handler already, so a race that never reads it raises no unhandled rejection.
 * An explicit timer, not `AbortSignal.timeout`, keeps the abort reason text, which reaches the logs.
 * @template T
 * @param {number} boundMs
 * @param {string} message
 * @param {(bound: { signal: AbortSignal, stopped: Promise<never> }) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTimeBound(boundMs, message, run) {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(new Error(message)), boundMs);
  timer.unref();
  const stopped = new Promise((_, reject) => {
    bound.signal.addEventListener("abort", () => reject(bound.signal.reason), { once: true });
  });
  stopped.catch(() => {});
  try {
    return await run({ signal: bound.signal, stopped });
  } finally {
    clearTimeout(timer);
  }
}
