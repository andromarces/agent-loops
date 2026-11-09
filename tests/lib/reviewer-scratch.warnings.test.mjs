import { expect, test, vi } from "vite-plus/test";

const hook = vi.hoisted(() => ({ failRemove: false }));

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    rm: (path, options) =>
      hook.failRemove
        ? Promise.reject(new Error("the removal was refused"))
        : actual.rm(path, options),
  };
});

const { createReviewerScratch, removeReviewerScratch } =
  await import("../../src/lib/reviewer-scratch.mjs");
const { withRunWarnings } = await import("../../src/lib/run-warnings.mjs");
const { createTempRepo } = await import("../git-helpers.mjs");
const { removePath } = await import("../fs-helpers.mjs");

// Usefulness: verifies a delete-by-hand scratch warning reaches the run warning list and the log.
test("a delete-by-hand reviewer scratch warning reaches the run warning list", async () => {
  const repo = await createTempRepo();
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
    warnings.mockRestore();
    await removePath(repo);
  }
});
