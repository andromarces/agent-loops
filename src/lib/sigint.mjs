import { killLiveTrees } from "./exec-tree.mjs";
import { logWarn, logError } from "./log.mjs";

const FORCE_EXIT_WAIT_MS = 2000;

const forceSignals = new WeakMap();

/**
 * The signal that `cancelOnSigInt` aborts on the second SIGINT, for the controller signal `signal`.
 * A read that must still run after the first cancel, such as the changed-path evidence snapshot of
 * a canceled turn, ends on this signal instead. Returns undefined for a signal that no
 * `cancelOnSigInt` call owns.
 * @param {AbortSignal | undefined} signal
 * @returns {AbortSignal | undefined}
 */
export function forceCancelSignal(signal) {
  return signal ? forceSignals.get(signal) : undefined;
}

/**
 * Aborts `controller` on the first SIGINT. On a second SIGINT it escalates, in this order:
 * force-kills the process tree of every live child (`killLiveTrees`), runs `onForceExit` (a
 * write of the transcript or envelope that the run holds), and exits with code 130. `onForceExit`
 * runs under a catch, so a failed write never keeps the process alive. When it returns a promise
 * (a write already in flight), the exit waits for it, for at most `FORCE_EXIT_WAIT_MS`.
 *
 * The second SIGINT also aborts `forceCancelSignal(controller.signal)`, before it ends the children.
 *
 * The listener uses `on`, not `once`: Node removes a `once` listener before it runs, so the execa
 * exit handler finds no SIGINT listener and re-raises the signal before the run sets exit 130 and
 * writes its transcript (#669). ADR 0033 lists what the second SIGINT keeps and drops.
 * @param {AbortController} controller
 * @param {{ onForceExit?: () => void }} [options]
 * @returns {() => void} removes the listener; every exit path of the caller must call it
 */
export function cancelOnSigInt(controller, { onForceExit } = {}) {
  const force = new AbortController();
  forceSignals.set(controller.signal, force.signal);
  const onSigInt = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      return;
    }
    logWarn("second SIGINT: ending the child processes and exiting with code 130");
    force.abort();
    killLiveTrees();
    const exit = () => process.exit(130);
    let pending;
    try {
      pending = onForceExit?.();
    } catch (err) {
      logError(`second SIGINT: the final write failed: ${err?.code ?? err?.message ?? err}`);
    }
    if (typeof pending?.then !== "function") {
      exit();
      return;
    }
    const bound = setTimeout(exit, FORCE_EXIT_WAIT_MS);
    pending.then(
      () => {
        clearTimeout(bound);
        exit();
      },
      () => {
        clearTimeout(bound);
        exit();
      },
    );
  };
  process.on("SIGINT", onSigInt);
  return () => {
    process.removeListener("SIGINT", onSigInt);
  };
}
