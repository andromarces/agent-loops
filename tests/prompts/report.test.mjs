import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { reportBlock, testSlotRule } from "../../src/prompts/report.mjs";

// The full-suite rule of every worker and reviewer turn (issue #848, ADR 0040).

// Usefulness: verifies a run whose paths cannot be quoted in every shell renders no wrapper
// command and leaves the child the required CI checks, so the prompt never carries a command that
// names another path.
test("an unquotable path leaves only the required CI checks", () => {
  const rule = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(rule).not.toContain("test-slot");
  expect(rule).toContain("Run a targeted test file directly.");
  expect(rule).toMatch(/rely on the required CI checks/);
});

// Usefulness: verifies the rendered wrapper runs a suite command in the default shell of the host
// (cmd on Windows, sh elsewhere), so a child that follows the rule runs its suite, not an error.
test("the rendered wrapper runs a suite command in the default shell", async () => {
  const shell = process.platform === "win32" ? "bash or cmd" : "sh";
  const form = testSlotRule()
    .split(" ; ")
    .map((part) => part.match(new RegExp(`${shell}: (.*test-slot -- "<full suite command>")`)))
    .find(Boolean);
  expect(form).toBeTruthy();
  const command = form[1].replace("<full suite command>", "node --version");
  const run = await execa(command, { shell: true, reject: false, all: true });
  expect(run.exitCode).toBe(0);
  expect(run.all).toMatch(/v\d+\.\d+\.\d+/);
});

// Usefulness: verifies the closing-block rule tells the child that one level of two-space sub-items
// folds with a comma and any other nesting blanks the block, the parser contract of issue #870, so
// the prompt never contradicts the parser.
test("the closing-block rule states the one-level sub-item fold", () => {
  expect(reportBlock).toMatch(
    /sub-items[^.]*two spaces, a hyphen, one space[^.]*folds into that item with a comma/,
  );
  expect(reportBlock).toMatch(/Any other list or nesting[^.]*unparseable/);
});
