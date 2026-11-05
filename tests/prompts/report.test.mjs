import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { parseReportBlock } from "../../src/lib/report.mjs";
import { reportBlock, testSlotRule } from "../../src/prompts/rules.mjs";

// The full-suite rule of every worker and reviewer turn (issue #848, ADR 0040).

// Usefulness: verifies a run whose paths cannot be quoted in every shell renders no wrapper
// command and leaves the child the required CI checks, so the prompt never carries a command that
// names another path.
test("an unquotable path leaves only the required CI checks", () => {
  const rule = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(rule).not.toContain("test-slot");
  expect(rule).not.toContain("--if-held");
  expect(rule).toContain("Run a targeted test file directly.");
  expect(rule).toMatch(/rely on the required CI checks/);
});

// Usefulness: verifies the rule bounds a direct targeted run and sends a broader run through the
// wrapper, or to the CI checks when no wrapper renders, so a child cannot start a many-file or
// whole-directory run outside the machine-wide test slot (issue #872).
test("the rule bounds a direct targeted run and sends a broader run through the wrapper", () => {
  const withWrapper = testSlotRule();
  expect(withWrapper).toMatch(/targeted run[^.]*at most 10 test files/);
  expect(withWrapper).toMatch(/never a whole directory/);
  expect(withWrapper).toMatch(/broader run[^.]*through the test slot wrapper, as a full suite/);
  const withoutWrapper = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(withoutWrapper).toMatch(/at most 10 test files/);
  expect(withoutWrapper).toMatch(/broader run[^.]*rely on the required CI checks/);
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

// Usefulness: verifies requirement "a targeted run may include the test files of direct importers of
// a changed file, inside the 10-file bound" (issue #1078), on both rule forms, so a worker or
// reviewer catches a caller that a change breaks before CI does.
test("the rule lets a targeted run add the tests of direct importers inside the 10-file bound", () => {
  const forms = [testSlotRule(), testSlotRule({ execPath: '/opt/no"de', platform: "linux" })];
  for (const rule of forms) {
    expect(rule).toMatch(
      /targeted run[^.]*mirror[^.]*changed source files[^.]*then[^.]*direct importers[^.]*at most 10 test files in total/,
    );
    expect(rule).toMatch(/never a whole directory/);
  }
});

// Usefulness: verifies requirement "a targeted run may include a test file that imports a changed
// source file directly, before the tests of direct importers" (issue #1492), on both rule forms, so
// a worker or reviewer catches a test that exercises the changed file before CI does.
test("the rule lets a targeted run add the tests that import a changed source file directly", () => {
  const forms = [testSlotRule(), testSlotRule({ execPath: '/opt/no"de', platform: "linux" })];
  for (const rule of forms) {
    expect(rule).toMatch(
      /targeted run[^.]*mirror[^.]*changed source files[^.]*then[^.]*import a changed source file directly[^.]*then[^.]*direct importers[^.]*at most 10 test files in total/,
    );
    expect(rule).toMatch(/never a whole directory/);
  }
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

// Usefulness: verifies the closing-block rule states the one-blank-line list fold of issue #1348.
// The prompt and the parser then agree on the shape a Claude worker wrote. No other test pins it.
test("the closing-block rule states the one-blank-line list fold", () => {
  expect(reportBlock).toMatch(
    /dash list under a label after one blank line[^.]*joins that label's value/,
  );
  expect(reportBlock).toMatch(/ordered list after a blank line stays unparseable/);
  expect(reportBlock).toMatch(/Two blank lines under a label before a dash list[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule states that a bold label name opening a list item
// is item text inside a run and unparseable outside one (issue #1006), so the prompt matches the parser.
test("the closing-block rule states the bold label name list item", () => {
  expect(reportBlock).toMatch(/dash item or sub-item[^.]*bold report label name[^.]*item text/);
  expect(reportBlock).toMatch(/outside a list under a label[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule states the whole-line bold heading exception of
// issue #1367. It also scopes the grouping rule outside that fold. The prompt and parser then
// agree on the fold that yields a report instead of null.
test("the closing-block rule states the whole-line bold heading exception", () => {
  expect(reportBlock).toMatch(/whole-line bold heading is the one `\*` exception/);
  expect(reportBlock).toMatch(
    /\*\*Reviewer notes\.\*\*` above `- a` reads `\*\*Reviewer notes\.\*\*: a`/,
  );
  expect(reportBlock).toMatch(/bold heading line that groups a dash list outside the prose fold/);
});

// Usefulness: verifies the rule names both issue #1380 shapes: an indented dash list under a label
// with no parent item, and a repeated label. The rule lives in reportBlock, which every later worker
// and reviewer turn repeats.
test("the closing-block rule names an indented list under a label and a repeated label", () => {
  expect(reportBlock).toMatch(/Each label appears once/);
  expect(reportBlock).toMatch(/list directly under a label starts at column 0/i);
  expect(reportBlock).toMatch(/indented dash list[^.]*no parent item above it[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule names the issue #1386 shape, a bold-lead paragraph
// with its own dash list between two labels. The exact observed response stays unparseable, so the
// prompt forbids the shape that produced a null report. No other test covers this shape.
test("the closing-block rule names a bold-lead paragraph with its own dash list", () => {
  const response = [
    "Conclusion: done",
    "Why: one line",
    "",
    "**Shared Git config incident.** The proxy read a stale config.",
    "- **What changed:** a",
    "- **Restored:** b",
    "- **If you need to check:** c",
    "- **After that:** d",
    "",
    "Blockers: none.",
    "Checks: none",
    "Notes: none",
    "Deferred: none",
  ].join("\n");
  expect(parseReportBlock(response)).toBeNull();
  expect(reportBlock).toMatch(/paragraph holds a bold lead and more prose on the same line/);
  expect(reportBlock).toMatch(
    /own dash list between two labels[^.]*unparseable[^.]*put the paragraph and its list under one label/,
  );
});

// Usefulness: verifies the issue #1380 rule forbids only the two observed shapes. A general
// one-line label rule fails the test. So does a prompt that drops a documented fold.
test("the closing-block rule forbids only the two observed shapes", () => {
  expect(reportBlock).not.toMatch(/label[^.]{0,60}\bon (?:its|one|the same) line\b/i);
  for (const fold of [
    /dash-plus-one-space items[^.]*directly under a label[^.]*joins into that label's value/,
    /sub-items[^.]*folds into that item with a comma/,
    /indented prose line directly after an item or its sub-items folds/,
    /dash list under a label after one blank line[^.]*joins/,
    /blank line[^.]*one plain prose line[^.]*list directly under it joins/,
  ]) {
    expect(reportBlock, fold.source).toMatch(fold);
  }
});
