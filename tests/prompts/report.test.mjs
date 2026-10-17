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
  expect(rule).not.toContain("--if-held");
  expect(rule).not.toMatch(/Run a targeted test file/);
  expect(rule).toMatch(/Do not run a test, a targeted test file included/);
  expect(rule).toMatch(/rely on the required CI checks/);
});

// Usefulness: verifies the rule bounds a targeted run and sends a broader run through the wrapper,
// so a child cannot start a many-file or whole-directory run outside the machine-wide test slot
// (issue #872).
test("the rule bounds a targeted run and sends a broader run through the wrapper", () => {
  const withWrapper = testSlotRule();
  expect(withWrapper).toMatch(/targeted[^.]*at most 10 test files[^.]*mirror[^.]*changed source/);
  expect(withWrapper).toMatch(/never a whole directory/);
  expect(withWrapper).toMatch(/broader run[^.]*through the test slot wrapper, as a full suite/);
});

// Usefulness: verifies requirement "a targeted run goes through the slot only while a slot is held"
// (issue #921, ADR 0044): the rule sends a targeted run through the wrapper with --if-held, keeps
// a full suite on the plain wrapper, and keeps the 10-file bound and the exit 75 handling.
test("the rule routes a targeted run through the wrapper with --if-held", () => {
  const rule = testSlotRule();
  expect(rule).toMatch(/targeted test file through the test slot wrapper with --if-held/);
  expect(rule).toMatch(
    /directly while all slots are free[^.]*waits for a slot while any slot is held/,
  );
  expect(rule).toMatch(/at most 10 test files/);
  expect(rule).toMatch(/full test suite only through the test slot wrapper, which waits/);
  expect(rule).toMatch(/Exit code 75[^.]*unresolved, not as a pass or a failure/);
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

// Usefulness: verifies the closing-block rule states the ordered-list fold and names the bold
// heading shape as unparseable (issue #915), so the prompt matches the parser contract.
test("the closing-block rule states the ordered list fold and forbids bold heading lines", () => {
  expect(reportBlock).toMatch(/ordered list[^.]*\(`1\. item`\)[^.]*joins into that label's value/);
  expect(reportBlock).toMatch(/bold heading line[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule states the heading-and-list fold of issue #898, so the
// prompt matches the parser contract and the plain-prose limits.
test("the closing-block rule states the heading and list fold", () => {
  expect(reportBlock).toMatch(
    /blank line[^.]*one plain prose line[^.]*list directly under it joins the label above/,
  );
});
