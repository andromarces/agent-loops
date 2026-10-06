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
