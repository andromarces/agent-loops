import { AsyncLocalStorage } from "node:async_hooks";

// The warning list of the run that the current async work belongs to, so the headless run records
// its own warnings and the interactive `role` path records none.
const storage = new AsyncLocalStorage();

/** Runs `fn` with `list` as the warning list of every warning that it records. */
export function withRunWarnings(list, fn) {
  return storage.run(list, fn);
}

/** Appends `message` to the warning list of the current run, or does nothing outside one. */
export function recordRunWarning(message) {
  storage.getStore()?.push(message);
}
