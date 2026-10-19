import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { removePath } from "../runtime-helpers.mjs";

// `swap` runs once, at the first filesystem or process call after `withTurnTmpdir` ran its
// callback. It stands for a swap after the removal validated its path and before it deletes.
const hook = vi.hoisted(() => ({ swap: null }));
const fire = () => {
  const swap = hook.swap;
  hook.swap = null;
  swap?.();
};

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual();
  const wrap =
    (name) =>
    async (...args) => {
      const result = await actual[name](...args);
      fire();
      return result;
    };
  return {
    ...actual,
    default: actual,
    lstat: wrap("lstat"),
    realpath: wrap("realpath"),
    rm: wrap("rm"),
    unlink: wrap("unlink"),
    rmdir: wrap("rmdir"),
  };
});

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    execFile: (...args) => {
      fire();
      return actual.execFile(...args);
    },
  };
});

const { withTurnTmpdir } = await import("../../src/lib/turn-tmpdir.mjs");

// Usefulness: verifies the removal never deletes through a parent that a swap turns into a link
// after validation, so a hostile swap cannot steer the delete into another directory.
test("a parent swapped to a link after validation loses nothing outside the turn directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "turn-tmpdir-"));
  const names = ["TMPDIR", "TEMP", "TMP"];
  const saved = names.map((name) => process.env[name]);
  try {
    const root = join(base, "root");
    const victim = join(base, "victim");
    await mkdir(root);
    await mkdir(victim);
    for (const name of names) process.env[name] = root;
    let sentinel;
    await withTurnTmpdir(async (env) => {
      const turn = basename(env.TMPDIR);
      mkdirSync(join(victim, turn));
      sentinel = join(victim, turn, "sentinel.txt");
      writeFileSync(sentinel, "keep\n");
      hook.swap = () => {
        renameSync(root, join(base, "moved"));
        symlinkSync(victim, root, "junction");
      };
    });
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  } finally {
    hook.swap = null;
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
    await removePath(base);
  }
});
