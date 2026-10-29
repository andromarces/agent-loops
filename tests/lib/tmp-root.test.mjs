import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { tmpRoot } from "../../src/lib/tmp-root.mjs";

const NAME = "AGENT_LOOP_TMP_ROOT_TEST";
afterEach(() => {
  delete process.env[NAME];
});

// Usefulness: the three machine-wide roots share this rule, so a set variable wins and an unset or
// empty one falls back to the leaf under the temporary directory.
test("tmpRoot returns the resolved override, else the leaf under the temporary directory", () => {
  const fallback = join(tmpdir(), "agent-loops", "leaf");
  expect(tmpRoot(NAME, "leaf")).toBe(fallback);
  process.env[NAME] = "";
  expect(tmpRoot(NAME, "leaf")).toBe(fallback);
  process.env[NAME] = "relative-root";
  expect(tmpRoot(NAME, "leaf")).toBe(resolve("relative-root"));
});
