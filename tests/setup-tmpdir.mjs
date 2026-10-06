import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vite-plus/test";
import { removePath } from "./runtime-helpers.mjs";

// Points `os.tmpdir()` at a per-file directory, so that anything `src` creates
// under it (the installer lock directory, the default runs root) is removed
// with the file and never reaches the real OS temp directory.
const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];
const saved = {};
let root;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "test-tmp-"));
  for (const name of TMP_VARS) {
    saved[name] = process.env[name];
    process.env[name] = root;
  }
});

afterAll(async () => {
  for (const name of TMP_VARS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
  await removePath(root);
});
