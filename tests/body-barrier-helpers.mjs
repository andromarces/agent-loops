/**
 * Tracks the bodies of tests that change process-wide state (a `console.error` spy,
 * `process.exitCode`). Vitest lets a body that passed its timeout keep running, so its late
 * cleanup can land inside the next test. `run(body)` registers a body, and `settled()` resolves
 * when every registered body has ended, whether it fulfilled or rejected. Call `settled()` from a
 * `beforeEach` hook, so no test starts while an earlier body still runs.
 *
 * `name` labels a body in errors (default: the function name). One wait lasts at most `waitMs`
 * (default 50 s, under the 60 s hook timeout of the callers). A wait that reaches it abandons the
 * bodies still running and rejects naming them. While an abandoned body runs, every later
 * `settled()` rejects at once with the same names, so one hung body costs one wait. When the body
 * ends, waits work again.
 */
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
