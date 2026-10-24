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
 * that needs a root sets it explicitly. Each `enter` saves the variables it finds, and the matching `exit` restores them on every path
 * and removes the directory only when that `enter` created one, so nested entry unwinds in order. `makeDir` and `removeDir` are seams for the failure-path test.
 */
export function createTmpdirIsolation({ makeDir = mkdtemp, removeDir = removePath } = {}) {
  // One frame per `enter`, so a nested or repeated entry restores the state it found, and the
  // outermost `exit` hands back the inherited values.
  const frames = [];
  return {
    async enter() {
      const frame = {
        original: Object.fromEntries(ISOLATED_VARS.map((name) => [name, process.env[name]])),
      };
      frames.push(frame);
      frame.root = await makeDir(join(tmpdir(), "test-tmp-"));
      for (const name of TMP_VARS) {
        process.env[name] = frame.root;
      }
      for (const name of ROOT_VARS) {
        delete process.env[name];
      }
    },
    async exit() {
      const frame = frames.pop();
      if (!frame) return;
      for (const name of ISOLATED_VARS) {
        if (frame.original[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = frame.original[name];
        }
      }
      if (frame.root) {
        await removeDir(frame.root);
      }
    },
  };
}

const isolation = createTmpdirIsolation();
beforeAll(isolation.enter);
afterAll(isolation.exit);
