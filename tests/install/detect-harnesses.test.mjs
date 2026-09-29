import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const probes = { inFlight: 0, peak: 0, present: new Set() };

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  // Stands in for the file system: each probe yields once so overlapping
  // probes are counted, and only paths in `probes.present` exist.
  access: async (path) => {
    probes.inFlight += 1;
    probes.peak = Math.max(probes.peak, probes.inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    probes.inFlight -= 1;
    if (!probes.present.has(path)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  },
}));

const { detectHarnesses } = await import("../../src/install/installer.mjs");

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  probes.present.clear();
  probes.inFlight = 0;
  probes.peak = 0;
});

// Usefulness: verifies detection probes PATH entries concurrently. A serial
// scan made the time grow with PATH length and machine load, which timed out
// the install test on slow runs (#365).
test("detectHarnesses probes PATH entries concurrently and keeps registry order", async () => {
  const dirs = ["a", "b", "c", "d"].map((name) => join("fake-bin", name));
  process.env.PATH = dirs.join(delimiter);
  // Present under the last PATH entry only, listed out of registry order.
  probes.present.add(join(dirs[3], "codex"));
  probes.present.add(join(dirs[3], "claude"));

  expect(await detectHarnesses()).toEqual(["claude", "codex"]);
  expect(probes.peak).toBeGreaterThan(1);
});
