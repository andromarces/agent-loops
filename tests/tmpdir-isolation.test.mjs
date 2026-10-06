import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { removePath } from "./runtime-helpers.mjs";

// Usefulness: acceptance (#503) — the installer lock directory that `src` creates under `tmpdir()` stays out of the real OS temp directory. Runner caches (vite, Node compile cache) are not test output and are not asserted.
test("a test run that reaches the installer lock leaves no agent-loops entry in the OS temp directory", async () => {
  const osTmp = await mkdtemp(join(tmpdir(), "tmpdir-isolation-"));
  try {
    await execa("pnpm", ["exec", "vp", "test", "run", "tests/install/install.lock.test.mjs"], {
      env: { TMPDIR: osTmp, TEMP: osTmp, TMP: osTmp },
      extendEnv: true,
    });
    expect(await readdir(osTmp)).not.toContain("agent-loops");
  } finally {
    await removePath(osTmp);
  }
}, 120000);
