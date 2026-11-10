import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/**
 * True when `child` is `parent` or lies below it, judged on the path text.
 */
export function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when the two paths are equal, ignoring only case on Windows. */
export function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** The `dev:ino` identity string of a `bigint` stat. */
export const fileIdentity = (info) => `${info.dev}:${info.ino}`;
