import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vite-plus/test";
import { removePath } from "./runtime-helpers.mjs";

const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];
// Roots that an agent-loop turn pins in its children (issues #955, #970, #1022). A pin inherited
// by a suite would send its writes to the real machine-wide root, so each is unset for the file.
const ROOT_VARS = [
  "AGENT_LOOP_RUNS_ROOT",
  "AGENT_LOOP_TEST_SLOTS_ROOT",
  "AGENT_LOOP_SESSION_RECORDS_ROOT",
];
const ISOLATED_VARS = [...TMP_VARS, ...ROOT_VARS];

/**
 * Points `os.tmpdir()` at a per-file directory, so that anything `src` creates
 * under it (the installer lock directory, the default runs root) is removed
 * with the file and never reaches the real OS temp directory. The inherited
 * `AGENT_LOOP_*_ROOT` pins are unset, so those defaults follow the per-file directory; a test
 * that needs a root sets it explicitly. `exit` restores the original variables on every path and removes the directory only when
 * `enter` created one. `makeDir` and `removeDir` are seams for the failure-path test.
 */
export function createTmpdirIsolation({ makeDir = mkdtemp, removeDir = removePath } = {}) {
  let original;
  let root;
  return {
    async enter() {
      original = Object.fromEntries(ISOLATED_VARS.map((name) => [name, process.env[name]]));
      root = await makeDir(join(tmpdir(), "test-tmp-"));
      for (const name of TMP_VARS) {
        process.env[name] = root;
      }
      for (const name of ROOT_VARS) {
        delete process.env[name];
      }
    },
    async exit() {
      if (original) {
        for (const name of ISOLATED_VARS) {
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
