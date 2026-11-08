import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The real path of `path`, or its resolved form when `realpath` fails, for example because the
 * path is missing.
 */
export async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
