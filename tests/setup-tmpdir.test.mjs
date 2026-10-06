import { expect, test, vi } from "vite-plus/test";
import { createTmpdirIsolation } from "./setup-tmpdir.mjs";

// Usefulness: a failed per-file directory creation leaves the temp variables as they were and removes nothing, so the next file does not inherit a changed or deleted TMPDIR.
test("a failed directory creation restores the temp variables and removes nothing", async () => {
  const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const removeDir = vi.fn();
  const isolation = createTmpdirIsolation({
    makeDir: async () => {
      throw new Error("disk full");
    },
    removeDir,
  });
  await expect(isolation.enter()).rejects.toThrow("disk full");
  await isolation.exit();
  expect({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual(
    before,
  );
  expect(removeDir).not.toHaveBeenCalled();
});
