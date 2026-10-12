import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vite-plus/test";
import { removePath } from "./runtime-helpers.mjs";

const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];

/**
 * Points `os.tmpdir()` at a per-file directory, so that anything `src` creates
 * under it (the installer lock directory, the default runs root) is removed
 * with the file and never reaches the real OS temp directory. `exit` restores
 * the original variables on every path and removes the directory only when
 * `enter` created one. `makeDir` and `removeDir` are seams for the failure-path test.
 */
export function createTmpdirIsolation({ makeDir = mkdtemp, removeDir = removePath } = {}) {
  let original;
  let root;
  return {
    async enter() {
      original = Object.fromEntries(TMP_VARS.map((name) => [name, process.env[name]]));
      root = await makeDir(join(tmpdir(), "test-tmp-"));
      for (const name of TMP_VARS) {
        process.env[name] = root;
      }
    },
    async exit() {
      if (original) {
        for (const name of TMP_VARS) {
          if (original[name] === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = original[name];
          }
        }
      }
      if (root) {
        await removeDir(root);
      }
    },
  };
}

const isolation = createTmpdirIsolation();
beforeAll(isolation.enter);
afterAll(isolation.exit);
