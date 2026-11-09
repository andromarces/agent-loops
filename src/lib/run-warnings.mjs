import { AsyncLocalStorage } from "node:async_hooks";
import { redactAndClean } from "./redact.mjs";

// The warning list of the run that the current async work belongs to, so the headless run records
// its own warnings and the interactive `role` path records none.
const storage = new AsyncLocalStorage();

export const MAX_RUN_WARNINGS = 20;

/**
 * Sorts and deduplicates `warnings`, redacts each one, and keeps the first 20. `warningsOverflow`
 * counts the entries outside the cap, so a capped list never reads as complete.
 * @param {string[]} warnings
 */
export function boundedWarnings(warnings) {
  const unique = [...new Set(warnings.map((warning) => redactAndClean(warning)))].sort();
  return {
    warnings: unique.slice(0, MAX_RUN_WARNINGS),
    warningsOverflow: Math.max(0, unique.length - MAX_RUN_WARNINGS),
  };
}

/** Runs `fn` with `list` as the warning list of every warning that it records. */
export function withRunWarnings(list, fn) {
  return storage.run(list, fn);
}

/** Appends the redacted `message` to the warning list of the current run, outside one it does nothing. */
export function recordRunWarning(message) {
  storage.getStore()?.push(redactAndClean(message));
}
