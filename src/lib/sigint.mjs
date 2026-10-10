import { killLiveTrees } from "./exec-tree.mjs";
import { logWarn, logError } from "./log.mjs";

/**
 * Aborts `controller` on the first SIGINT. On a second SIGINT it escalates, in this order:
 * force-kills the process tree of every live child (`killLiveTrees`), runs `onForceExit` (a
 * synchronous write of the transcript or envelope that the run holds), and exits with code 130.
 * `onForceExit` runs under a catch, so a failed write never keeps the process alive.
 *
 * The listener uses `on`, not `once`: Node removes a `once` listener before it runs, so the execa
 * exit handler finds no SIGINT listener and re-raises the signal before the run sets exit 130 and
 * writes its transcript (#669). ADR 0029 lists what the second SIGINT keeps and drops.
 * @param {AbortController} controller
 * @param {{ onForceExit?: () => void }} [options]
 * @returns {() => void} removes the listener; every exit path of the caller must call it
 */
export function cancelOnSigInt(controller, { onForceExit } = {}) {
  const onSigInt = () => {
    if (!controller.signal.aborted) {
      controller.abort();
      return;
    }
    logWarn("second SIGINT: ending the child processes and exiting with code 130");
    killLiveTrees();
    try {
      onForceExit?.();
    } catch (err) {
      logError(`second SIGINT: the final write failed: ${err?.code ?? err?.message ?? err}`);
    }
    process.exit(130);
  };
  process.on("SIGINT", onSigInt);
  return () => {
    process.removeListener("SIGINT", onSigInt);
  };
}
