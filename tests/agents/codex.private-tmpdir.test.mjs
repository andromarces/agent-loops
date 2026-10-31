import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { exists, removePath, symlinkOrSkip } from "../runtime-helpers.mjs";
import {
  TMP_VARS,
  OK_EVENTS,
  withInheritedTmp,
  fakeCodex,
  runTurn,
} from "./codex-tmpdir-helpers.mjs";

// Only `exec` is replaced: the turn directory removal runs its helper through `execBounded`.
vi.mock("../../src/lib/exec.mjs", async (importActual) => ({
  ...(await importActual()),
  exec: vi.fn(),
}));

// Usefulness: verifies acceptance #955 — a Codex turn leaves no new entry in the inherited
// temporary directory, because the CLI gets a private per-turn one that the runtime removes.
test.each([
  ["reviewer", { readOnly: true, sandbox: "none", role: "reviewer" }],
  ["worker", { role: "worker" }],
  ["orchestrator", { readOnly: true, role: "orchestrator" }],
])("a codex %s turn leaves nothing in the inherited temporary directory", async (_name, opts) => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const seen = fakeCodex();
    await withInheritedTmp(root, () => runTurn(opts), `${root}-runs`);
    expect(await readdir(root)).toEqual([]);
    expect(seen.home).not.toBe(root);
    for (const name of TMP_VARS) expect(seen.env[name]).toBe(seen.home);
    expect(basename(seen.home).length).toBeLessThanOrEqual(12);
  } finally {
    await removePath(root);
    await removePath(`${root}-runs`);
  }
});

// Usefulness: verifies the cleanup also runs when the CLI fails, times out, or is canceled, so
// no failure path leaks the private directory.
test.each([
  ["a failure", {}],
  ["a timeout", { timedOut: true }],
  ["a cancel", { isCanceled: true }],
])("a codex turn that ends with %s still removes its temporary directory", async (_n, flags) => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    fakeCodex(async () => {
      throw Object.assign(new Error("codex failed"), flags);
    });
    await expect(withInheritedTmp(root, () => runTurn(), `${root}-runs`)).rejects.toThrow(
      "codex failed",
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await removePath(root);
    await removePath(`${root}-runs`);
  }
});

// Usefulness: verifies a concurrent process keeps its own directory and file in the shared
// temporary directory, so the cleanup touches only the directory that this turn created.
test("a codex turn leaves a concurrent entry in the inherited temporary directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    await mkdir(join(root, ".tmpOther1"));
    await writeFile(join(root, "other.txt"), "keep\n");
    fakeCodex();
    await withInheritedTmp(root, () => runTurn(), `${root}-runs`);
    expect((await readdir(root)).sort()).toEqual([".tmpOther1", "other.txt"]);
  } finally {
    await removePath(root);
    await removePath(`${root}-runs`);
  }
});

// Usefulness: verifies a user-set temporary directory that is itself a link still works, and the
// private directory lands under its target, so a user who set TMPDIR keeps a working turn.
test("a codex turn works when the user temporary directory is a link", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    await mkdir(join(base, "real"));
    await symlinkOrSkip(ctx, join(base, "real"), join(base, "link"), "junction");
    const seen = fakeCodex();
    await withInheritedTmp(join(base, "link"), () => runTurn(), join(base, "runs"));
    expect(seen.home.startsWith(join(base, "link"))).toBe(true);
    expect(await readdir(join(base, "real"))).toEqual([]);
  } finally {
    await removePath(base);
  }
});

// Usefulness: verifies the removal never follows a link that replaces the private directory, so a
// swap during the turn cannot delete content outside it.
test("a codex turn never follows a link at the private directory", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const root = join(base, "root");
    const victim = join(base, "victim");
    await mkdir(root);
    await mkdir(victim);
    await writeFile(join(victim, "keep.txt"), "keep\n");
    fakeCodex(async (home) => {
      await removePath(home);
      await symlinkOrSkip(ctx, victim, home, "junction");
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, () => runTurn());
    expect(await readFile(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
  } finally {
    await removePath(base);
  }
});

// Usefulness: verifies the removal never follows a link at a parent component, not only at the
// target, so a swapped temporary root cannot steer the delete into another directory.
test("a codex turn never follows a link at a parent of the private directory", async (ctx) => {
  const base = await mkdtemp(join(tmpdir(), "codex-tmp-"));
  try {
    const root = join(base, "root");
    const victim = join(base, "victim");
    await mkdir(root);
    await mkdir(victim);
    fakeCodex(async (home) => {
      await mkdir(join(victim, basename(home)));
      await writeFile(join(victim, basename(home), "keep.txt"), "keep\n");
      await rename(root, join(base, "moved"));
      await symlinkOrSkip(ctx, victim, root, "junction");
      return { stdout: OK_EVENTS, stderr: "" };
    });
    await withInheritedTmp(root, () => runTurn());
    expect(await exists(join(victim, "keep.txt"))).toBe(false);
    const [name] = await readdir(victim);
    expect(await exists(join(victim, name, "keep.txt"))).toBe(true);
  } finally {
    await removePath(base);
  }
});
