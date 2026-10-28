// The manifest-save warning of a failed install must carry readable text for any
// rejection value (#1190). The `writeManifest` and `logWarn` mocks apply to the
// whole module graph, so this file stays separate from installer.manifest.test.mjs,
// whose cases need the real manifest write.
import { afterEach, expect, test, vi } from "vite-plus/test";
import { install } from "../../src/install/installer.mjs";
import { logWarn } from "../../src/lib/log.mjs";
import { cleanupHomes, makeHome, PACKAGE_ROOT } from "./install-helpers.mjs";

vi.mock("../../src/lib/log.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  logWarn: vi.fn(),
}));

vi.mock("../../src/install/manifest.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  writeManifest: vi.fn(async () => {
    // A rejection value that is not an Error, as a hostile or legacy callee can throw.
    throw "disk full";
  }),
}));

afterEach(cleanupHomes);

// Usefulness: verifies acceptance #1190 — a manifest-save failure that rejects with a
// non-Error value still names its cause in the warning. No other test reaches this path.
test("a manifest-save rejection with a non-Error value logs readable text", async () => {
  const home = await makeHome();
  const write = async () => {
    throw new Error("simulated write failure");
  };

  await expect(
    install({ harnesses: ["claude"], home, packageRoot: PACKAGE_ROOT, write }),
  ).rejects.toThrow("simulated write failure");

  expect(logWarn).toHaveBeenCalledOnce();
  const message = vi.mocked(logWarn).mock.calls[0][0];
  expect(message).toContain("(disk full)");
  expect(message).not.toContain("undefined");
});
