import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { withTurnTmpdir } from "../../src/lib/turn-tmpdir.mjs";
import { removePath } from "../runtime-helpers.mjs";

const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];

// Runs `body(root, base)` with the inherited temporary directory set to a fresh `root`.
async function withRoot(body) {
  const base = await mkdtemp(join(tmpdir(), "turn-tmpdir-"));
  const saved = TMP_VARS.map((name) => process.env[name]);
  const root = join(base, "root");
  mkdirSync(root);
  for (const name of TMP_VARS) process.env[name] = root;
  try {
    return await body(root, base);
  } finally {
    TMP_VARS.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    await removePath(base);
  }
}

// Usefulness: verifies a directory that replaces the turn directory before the removal starts keeps
// its content, because the removal acts only on the directory that the runtime created.
test("a replacement of the turn directory loses no content", async () => {
  await withRoot(async (root, base) => {
    let sentinel;
    await withTurnTmpdir(async (env) => {
      renameSync(env.TMPDIR, join(base, "moved"));
      mkdirSync(env.TMPDIR);
      sentinel = join(env.TMPDIR, "sentinel.txt");
      writeFileSync(sentinel, "keep\n");
    });
    expect(existsSync(sentinel)).toBe(true);
    expect(readdirSync(root)).toHaveLength(1);
  });
});

// Usefulness: verifies a directory that replaces the turn directory while the removal runs is not
// removed by the final `rmdir`, so the removal never deletes a directory it did not create.
test("a replacement during the removal keeps its empty directory", async () => {
  await withRoot(async (root) => {
    const TOP = 400;
    let replacement;
    await withTurnTmpdir(async (env) => {
      for (let d = 0; d < TOP; d++) {
        mkdirSync(join(env.TMPDIR, `d${d}`));
        for (let f = 0; f < 25; f++) writeFileSync(join(env.TMPDIR, `d${d}`, `f${f}`), "x");
      }
      replacement = env.TMPDIR;
      // Swaps as soon as the removal has started deleting content.
      const poll = setInterval(() => {
        try {
          if (readdirSync(replacement).length < TOP) {
            clearInterval(poll);
            renameSync(replacement, join(root, "moved"));
            mkdirSync(replacement);
          }
        } catch {
          // The directory is mid-swap or gone: the next tick or the end of the test decides.
        }
      }, 1);
      setTimeout(() => clearInterval(poll), 20_000).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(replacement)).toBe(true);
    expect(readdirSync(root).sort()).toEqual(["moved", basename(replacement)].sort());
  });
}, 30_000);
