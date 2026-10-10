/**
 * Aborts `controller` on the first SIGINT, and ends the process with exit code 130 on a second one.
 * The listener uses `on`, not `once`: Node removes a `once` listener before it runs, so the execa
 * exit handler finds no SIGINT listener and re-raises the signal before the run sets exit 130 and
 * writes its transcript (#669). The second-signal exit is the way out of a stalled cleanup, and it
 * skips the transcript write.
 * @param {AbortController} controller
 * @returns {() => void} removes the listener; every exit path of the caller must call it
 */
export function cancelOnSigInt(controller) {
  const onSigInt = () => {
    if (controller.signal.aborted) {
      process.exit(130);
    }
    controller.abort();
  };
  process.on("SIGINT", onSigInt);
  return () => {
    process.removeListener("SIGINT", onSigInt);
  };
}
