import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const probed = [];
const present = new Set();

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal()),
  // Stands in for the file system: records every probed path, and only paths
  // in `present` exist.
  access: async (path) => {
    probed.push(path);
    await new Promise((resolve) => setImmediate(resolve));
    if (!present.has(path)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  },
}));

const { detectHarnesses } = await import("../../src/install/installer.mjs");

const dirs = ["a", "b", "c"].map((name) => join("fake-bin", name));
const path = dirs.join(delimiter);

afterEach(() => {
  probed.length = 0;
  present.clear();
});

// Usefulness: verifies detection returns registry order whatever the PATH order
// and probe timing, so the result is stable under load.
test("detectHarnesses returns found harnesses in registry order", async () => {
  present.add(join(dirs[2], "codex"));
  present.add(join(dirs[1], "claude"));
  present.add(join(dirs[0], "agy"));

  expect(await detectHarnesses({ path })).toEqual(["claude", "codex", "antigravity"]);
});

// Usefulness: verifies a command found on PATH stops further probes for that
// command, so a common install location keeps the scan short (#365).
test("detectHarnesses stops probing a command after the first PATH match", async () => {
  present.add(join(dirs[0], "claude"));

  expect(await detectHarnesses({ path })).toEqual(["claude"]);
  expect(probed.filter((p) => p.startsWith(join(dirs[1], "claude")))).toEqual([]);
  expect(probed.filter((p) => p.startsWith(join(dirs[2], "claude")))).toEqual([]);
});

// Usefulness: verifies a harness with two commands stops at the first command
// found, and still detects the harness through the second command.
test("detectHarnesses tries the next command of a harness until one is found", async () => {
  present.add(join(dirs[1], "antigravity"));

  expect(await detectHarnesses({ path })).toEqual(["antigravity"]);
});
