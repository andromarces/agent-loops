/**
 * Runs `run({ signal, stopped })` under a time bound of `boundMs`. At the bound, `signal` aborts
 * with `new Error(message)`, or with the default `AbortError` when `message` is undefined, and
 * `stopped` rejects with the same reason, so `Promise.race([call, stopped])` ends the wait for a
 * call that cannot be canceled. The timer is unref'd, so a pending
 * read never keeps the process alive, and it is cleared when `run` settles. `stopped` has a
 * handler already, so a race that never reads it raises no unhandled rejection.
 * An explicit timer, not `AbortSignal.timeout`, keeps the abort reason text, which reaches the logs.
 * @template T
 * @param {number} boundMs
 * @param {string | undefined} message
 * @param {(bound: { signal: AbortSignal, stopped: Promise<never> }) => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTimeBound(boundMs, message, run, { start = null } = {}) {
  const bound = new AbortController();
  let timer;
  let settled = false;
  const arm = () => {
    if (settled) return;
    timer = setTimeout(
      () => (message === undefined ? bound.abort() : bound.abort(new Error(message))),
      boundMs,
    );
    timer.unref();
  };
  // The caller can gate the timer start; production starts it at once (issue #1465).
  if (start === null) arm();
  else
    Promise.resolve(start)
      .then(arm)
      .catch(() => {});
  const stopped = new Promise((_, reject) => {
    bound.signal.addEventListener("abort", () => reject(bound.signal.reason), { once: true });
  });
  stopped.catch(() => {});
  try {
    return await run({ signal: bound.signal, stopped });
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}
