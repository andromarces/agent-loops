import { realpathSync } from "node:fs";

/**
 * Reports whether the module at modulePath is the process entry point.
 *
 * Compares real paths, so a bin shim that reaches the file through a symlinked
 * package directory (pnpm, npm on POSIX) still matches. A plain path compare
 * fails there, and the CLI exits without running.
 */
export function isEntryPoint(modulePath) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
