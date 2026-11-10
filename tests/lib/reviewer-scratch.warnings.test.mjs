import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

const hook = vi.hoisted(() => ({ failRemove: false, failLstat: null, root: null }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    lstat: (path, options) =>
      path === hook.failLstat
        ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
        : actual.lstat(path, options),
    rm: (path, options) =>
      hook.failRemove
        ? Promise.reject(new Error("the removal was refused"))
        : actual.rm(path, options),
  };
});

vi.mock("../../src/lib/snapshot.mjs", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    workTreeRoot: async () => hook.root,
  };
});

const { createReviewerScratch, removeReviewerScratch } =
  await import("../../src/lib/reviewer-scratch.mjs");
const { withRunWarnings } = await import("../../src/lib/run-warnings.mjs");
const { exists, removePath } = await import("../fs-helpers.mjs");

// Usefulness: verifies a delete-by-hand scratch warning reaches the run warning list and the log.
test("a delete-by-hand reviewer scratch warning reaches the run warning list", async () => {
  const repo = await mkdtemp(join(tmpdir(), "reviewer-scratch-warning-"));
  hook.root = repo;
  const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const dir = await createReviewerScratch(repo);
    hook.failRemove = true;
    const collected = [];
    await withRunWarnings(collected, () => removeReviewerScratch(dir));
    expect(collected.some((line) => line.includes("delete it by hand"))).toBe(true);
    expect(warnings.mock.calls.some(([line]) => String(line).includes("delete it by hand"))).toBe(
      true,
    );
  } finally {
    hook.failRemove = false;
    hook.root = null;
    warnings.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies an unexpected parent read error warns and resolves without deleting the scratch folder.
test("an unexpected parent read error warns and deletes nothing", async () => {
  const repo = await mkdtemp(join(tmpdir(), "reviewer-scratch-error-"));
  hook.root = repo;
  const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const dir = await createReviewerScratch(repo);
    await writeFile(join(dir, "keep.txt"), "keep\n");
    hook.failLstat = join(repo, ".agent-loop");
    await expect(removeReviewerScratch(dir)).resolves.toBeUndefined();
    expect(warnings.mock.calls.flat().join("\n")).toContain("reviewer scratch folder not removed");
    expect(await exists(dir)).toBe(true);
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("keep\n");
  } finally {
    hook.failLstat = null;
    hook.root = null;
    warnings.mockRestore();
    await removePath(repo);
  }
});
