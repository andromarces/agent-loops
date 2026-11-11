import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Real path of the nearest existing ancestor plus the missing tail. */
const real = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    // A symlinked parent or a Windows 8.3 short name expands inside the native call.
    return parent === path ? path : join(real(parent), basename(path));
  }
};

/** True when `value`, resolved against `root`, is the local `<root>/.husky/_` path. */
export const isLocalHuskyHooksPath = (root, value) =>
  real(resolve(root, value)) === real(resolve(root, ".husky/_"));
