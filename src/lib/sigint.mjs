import { endCommandTrees, killLiveTrees } from "./exec-tree.mjs";
import { logWarn, logError } from "./log.mjs";

const FORCE_EXIT_WAIT_MS = 2000;

// Milliseconds that a deferred exit waits for the run to write its result before it exits.
const DEFERRED_EXIT_WAIT_MS = 5000;

const forceSignals = new WeakMap();
const evidenceReads = new WeakMap();

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
 * Marks an evidence read as running, for the force-cancel signal `forceSignal`. A second SIGINT that
 * arrives while one runs ends the read and lets the run write its canceled result before the exit.
 * Returns the function that ends the mark. With no signal, it returns a no-op.
 * @param {AbortSignal | undefined} forceSignal
 * @returns {() => void}
 */
export function beginEvidenceRead(forceSignal) {
  if (!forceSignal) {
    return () => {};
  }
  evidenceReads.set(forceSignal, (evidenceReads.get(forceSignal) ?? 0) + 1);
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      evidenceReads.set(forceSignal, evidenceReads.get(forceSignal) - 1);
    }
  };
}

/**
 * Aborts `controller` on the first SIGINT. On a second SIGINT it escalates, in this order:
 * force-kills the process tree of every live child (`killLiveTrees`), runs `onForceExit` (a
 * write of the transcript or envelope that the run holds), and exits with code 130. `onForceExit`
 * runs under a catch, so a failed write never keeps the process alive. When it returns a promise
 * (a write already in flight), the exit waits for it, for at most `FORCE_EXIT_WAIT_MS`.
 *
 * The second SIGINT aborts `forceCancelSignal(controller.signal)` first. If an evidence read runs
 * (`beginEvidenceRead`), the exit is deferred: the read ends as canceled, the run writes its result,
 * and the exit with code 130 follows when the returned remover runs, or after
 * `DEFERRED_EXIT_WAIT_MS` through the steps below. A third SIGINT runs the steps below at once.
 *
 * The listener uses `on`, not `once`: Node removes a `once` listener before it runs, so the execa
 * exit handler finds no SIGINT listener and re-raises the signal before the run sets exit 130 and
 * writes its transcript (#669). ADR 0033 lists what the second SIGINT keeps and drops.
 * @param {AbortController} controller
 * @param {{ onForceExit?: () => void | Promise<void> }} [options]
 * @returns {() => void} removes the listener; every exit path of the caller must call it
 */
export function cancelOnSigInt(controller, { onForceExit } = {}) {
  const force = new AbortController();
  forceSignals.set(controller.signal, force.signal);
  let deferredExit = null;
  const onSigInt = () => {
    if (!controller.signal.aborted) {
      // Before the abort: the abort kills the group of the child. A descendant that left that group
      // is found only while the child lives.
      endCommandTrees();
      controller.abort();
      return;
    }
    if (deferredExit === null && !force.signal.aborted && evidenceReads.get(force.signal) > 0) {
      logWarn("second SIGINT: ending the evidence snapshot; exiting with code 130 after the write");
      force.abort();
      deferredExit = setTimeout(onSigInt, DEFERRED_EXIT_WAIT_MS);
      return;
    }
    clearTimeout(deferredExit);
    logWarn("second SIGINT: ending the child processes and exiting with code 130");
    force.abort();
    endCommandTrees();
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
    // The run finished its writes, so the deferred exit happens now.
    if (deferredExit !== null) {
      clearTimeout(deferredExit);
      endCommandTrees();
      killLiveTrees();
      process.exit(130);
    }
  };
}
