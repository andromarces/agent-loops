import { expect, test } from "vite-plus/test";
import { runHarnessCheckCommand } from "../../src/install/commands.mjs";
import { HARNESS_META, HARNESS_ORDER, harnessForCommand } from "../../src/lib/harnesses.mjs";
import { harnessForProcessName } from "../../src/lib/process-ancestry.mjs";

test("every registry command resolves to its harness in process detection and the check", async () => {
  for (const harness of HARNESS_ORDER) {
    for (const command of HARNESS_META[harness].commands) {
      expect(harnessForCommand(command)).toBe(harness);
      expect(harnessForProcessName(command)).toBe(harness);

      process.exitCode = undefined;
      await runHarnessCheckCommand([command], { lookup: async () => harness });
      expect(process.exitCode).toBe(0);
    }
  }
  process.exitCode = undefined;
});

test("a name outside the registry resolves to no harness", () => {
  expect(harnessForCommand("nonexistent")).toBeUndefined();
  expect(harnessForCommand("constructor")).toBeUndefined();
});

// Usefulness: verifies #185 — a harness note carries the data the installer needs, and only
// harnesses with a note declare one.
test("each registry note names a path, text, and dry-run behavior", () => {
  const withNotes = HARNESS_ORDER.filter((harness) => HARNESS_META[harness].notes);
  expect(withNotes.toSorted()).toEqual(["claude", "codex"]);
  for (const harness of withNotes) {
    for (const note of HARNESS_META[harness].notes) {
      expect(Array.isArray(note.path)).toBe(true);
      expect(note.detail.length).toBeGreaterThan(0);
      expect(typeof note.dryRun).toBe("boolean");
    }
  }
});
