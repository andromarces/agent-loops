// Bounds a `gh` runner: a deadline, a caller signal, and a group of reads that settle before a
// failure returns. The gate, the check wait, and the batch calls share it.

/** A runner whose calls also end when `signal` aborts, beside any signal the caller's runner already carries. */
export const withSignal =
  (gh, signal) =>
  (args, cwd, options = {}) =>
    gh(args, cwd, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
    });

/** The error of a read that reached its deadline. `timedOut` tells it from a cancel and from another read error. */
export const readTimeout = (timeoutMs) =>
  Object.assign(new Error(`the read timed out after ${timeoutMs}ms`), { timedOut: true });

/**
 * A runner for one gate call: every `gh` call ends when `timeoutMs` expires or `signal` aborts, and
 * `timeoutMs` also bounds each child. `deadline` is the deadline signal alone, so a caller tells a
 * timeout from a caller cancel. A reply that the runner marks `timedOut`, or that arrives after the
 * deadline expired, throws `readTimeout` and never reaches the caller as data. A gate then cannot
 * pass on a read that its bound cut short.
 * @param {Function} gh
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 */
export function boundedCall(gh, timeoutMs, signal = null) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = withSignal(
    (args, cwd, options) => gh(args, cwd, { timeoutMs, ...options }),
    signal ? AbortSignal.any([deadline, signal]) : deadline,
  );
  const call = async (args, cwd, options) => {
    const reply = await bounded(args, cwd, options);
    if (reply?.timedOut || deadline.aborted) {
      throw readTimeout(timeoutMs);
    }
    return reply;
  };
  call.deadline = deadline;
  return call;
}

/**
 * A runner for one long command, such as a batch run. Every call ends when its bound expires or
 * a signal aborts. A caller bound wins over the default, and a caller signal joins the run signal.
 * A reply that ends after an abort throws and reaches the caller as no data. The first abort
 * source decides between a cancel and a timeout.
 * @param {Function} gh
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 */
export function boundedRunner(gh, timeoutMs, signal = null) {
  return async (args, cwd, options = {}) => {
    const bound = options.timeoutMs ?? timeoutMs;
    const deadline = AbortSignal.timeout(bound);
    const signals = [options.signal, signal, deadline].filter(Boolean);
    const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let canceled = false;
    let cancelReason;
    combined.addEventListener(
      "abort",
      () => {
        if (deadline.aborted) return;
        canceled = true;
        cancelReason = combined.reason;
      },
      { once: true },
    );
    if (deadline.aborted) throw readTimeout(bound);
    if (combined.aborted) {
      canceled = true;
      cancelReason = combined.reason;
    }
    if (canceled) throw canceledCall(cancelReason);
    const reply = await gh(args, cwd, { ...options, timeoutMs: bound, signal: combined });
    if (canceled) throw canceledCall(cancelReason);
    if (reply?.timedOut || deadline.aborted) throw readTimeout(bound);
    return reply;
  };
}

/** The error of a call that ended after a caller signal aborted, with that reason as `cause`. */
function canceledCall(reason) {
  return Object.assign(new Error("the call was canceled"), { name: "AbortError", cause: reason });
}

/**
 * The first failure of a group, in sequential order, carried past the wait for
 * the cancelled siblings. `expired` is whether the caller's deadline (`gh.deadline`)
 * had already fired when the failure was captured. A failure captured before the
 * deadline stays the outcome, so a deadline that expires during the wait cannot
 * replace it. The entry points unwrap it with `failureOf`.
 */
export class ReadFailure {
  constructor(cause, expired) {
    this.cause = cause;
    this.expired = expired;
  }
}

export const failureOf = (err) => (err instanceof ReadFailure ? err.cause : err);

/**
 * Runs independent reads together, and each maker receives a runner that the group can cancel.
 * The reads are awaited in list order, so the first failure throws as soon as it is reached, with
 * the error a sequential run surfaces. A later sibling that is slow or stalled never delays that
 * error. On a failure the remaining reads are cancelled and settled before the throw, so no `gh`
 * child outlives the caller. `stopWhen(value)` ends the group early, as a sequential caller that
 * returns at that value does, and the later reads are then cancelled and settled.
 */
export async function inOrder(gh, makers, stopWhen = () => false) {
  const group = new AbortController();
  const scoped = withSignal(gh, group.signal);
  const reads = makers.map((make) => make(scoped));
  for (const read of reads) {
    read.catch(() => {});
  }
  try {
    const values = [];
    for (const read of reads) {
      const value = await read;
      values.push(value);
      if (stopWhen(value)) {
        group.abort();
        await Promise.allSettled(reads);
        // Their failures are never surfaced, and the values read so far are returned.
        break;
      }
    }
    return values;
  } catch (err) {
    const expired = gh.deadline?.aborted ?? false;
    group.abort();
    await Promise.allSettled(reads);
    throw new ReadFailure(err, expired);
  }
}
