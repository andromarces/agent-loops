import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { parseReportBlock } from "../../src/lib/report.mjs";
import { initTaskBlock, redRunRule, reportBlock, testSlotRule } from "../../src/prompts/rules.mjs";

// The full-suite rule of every worker and reviewer turn (issue #848, ADR 0040).

// Usefulness: verifies a run whose paths cannot be quoted in every shell renders no wrapper
// command and leaves the child the required CI checks, so the prompt never carries a command that
// names another path.
test("an unquotable path leaves only the required CI checks", () => {
  const rule = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(rule).not.toContain("test-slot");
  expect(rule).not.toContain("--if-held");
  expect(rule).toContain("Run a targeted test file directly.");
  expect(rule).toMatch(/rely on the required CI checks/i);
});

// Usefulness: verifies the rule bounds a direct targeted run and sends a broader run through the
// wrapper, or to the CI checks when no wrapper renders, so a child cannot start a many-file or
// whole-directory run outside the machine-wide test slot (issue #872).
test("the rule bounds a direct targeted run and sends a broader run through the wrapper", () => {
  const withWrapper = testSlotRule();
  expect(withWrapper).toMatch(/targeted run[\s\S]*?at most 10 test files/);
  expect(withWrapper).toMatch(/never a whole directory/);
  expect(withWrapper).toMatch(/broader run[^.]*through the test slot wrapper, as a full suite/);
  const withoutWrapper = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(withoutWrapper).toMatch(/at most 10 test files/);
  expect(withoutWrapper).toMatch(/broader run[\s\S]*?rely on the required CI checks/i);
});

// Usefulness: issue #1919: the rule bars concurrent copies and a background test run, and sends a
// single test through --if-held. No other test pins this.
test("the rule runs one test command at a time", () => {
  // Explicit paths render each command form on every host, whatever its path separators.
  const forms = [
    testSlotRule({
      execPath: "/opt/node",
      cliPath: "/repo/src/cli.mjs",
      platform: "linux",
    }),
    testSlotRule({
      execPath: "C:/node/node.exe",
      cliPath: "C:/repo/src/cli.mjs",
      platform: "win32",
    }),
  ];
  for (const rule of forms) {
    expect(rule).toContain("Run one test command at a time.");
    expect(rule).toContain(
      "Start no concurrent copy of a test run and no test run in the background, also when it ends inside the same command.",
    );
    expect(rule).toContain(
      "A single-test run is a targeted run and takes the --if-held wrapper form.",
    );
  }
  const fallback = testSlotRule({ execPath: '/opt/no"de', platform: "linux" });
  expect(fallback).toContain("Run one test command at a time.");
  expect(fallback).toContain("Start no concurrent copy of a test run");
  expect(fallback).not.toContain("--if-held");
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
      /targeted run[\s\S]*?mirror[\s\S]*?changed source files[\s\S]*?[Tt]hen[\s\S]*?direct importers[\s\S]*?at most 10 test files in total/,
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
      /targeted run[\s\S]*?mirror[\s\S]*?changed source files[\s\S]*?[Tt]hen[\s\S]*?import a changed source file directly[\s\S]*?[Tt]hen[\s\S]*?direct importers[\s\S]*?at most 10 test files in total/,
    );
    expect(rule).toMatch(/never a whole directory/);
  }
});

// Usefulness: verifies requirement "a targeted run may include a test file that names a changed
// script or config file by path" (issue #1611), on both rule forms, so a worker or reviewer catches
// a text reader that no import edge reaches before CI does; no other test pins this tier.
test("the rule lets a targeted run add the tests that name a changed non-module file", () => {
  const forms = [testSlotRule(), testSlotRule({ execPath: '/opt/no"de', platform: "linux" })];
  for (const rule of forms) {
    expect(rule).toMatch(
      /targeted run[\s\S]*?[Tt]hen[\s\S]*?name the path or file name of a changed file that is not an importable module[\s\S]*?at most 10 test files in total/,
    );
    expect(rule).toMatch(/never a whole directory/);
  }
});

// Usefulness: issue #1673 — the rendered wrapper passes the suite command as an argument vector
// that runs without a shell, so a child that follows the rule runs its suite with no quoting step.
test("the rendered wrapper runs the suite as an argument vector without a shell", async () => {
  const shell = process.platform === "win32" ? "bash or cmd" : "sh";
  const form = testSlotRule()
    .split(" ; ")
    .map((part) =>
      part.match(new RegExp(`${shell}: (.*test-slot -- <suite command as separate arguments>)`)),
    )
    .find(Boolean);
  expect(form).toBeTruthy();
  const command = form[1].replace("<suite command as separate arguments>", "node --version");
  const run = await execa(command, { shell: true, reject: false, all: true });
  expect(run.exitCode).toBe(0);
  expect(run.all).toMatch(/v\d+\.\d+\.\d+/);
});

// Usefulness: verifies the rule names the cmd.exe/POSIX shell and the Git Bash form (issue #1590); no other test pins it.
test("the rule names the platform shell that runs the quoted suite command", () => {
  const rule = testSlotRule();
  expect(rule).toMatch(
    /quoted command in cmd\.exe on Windows and \/bin\/sh on POSIX, not in your shell tool/,
  );
  expect(rule).toContain("bash -c '<command>'");
  expect(rule).toMatch(/absolute paths/);
});

// Usefulness: issue #1673 — the rule names the argument-vector form as the default from Git Bash
// on Windows and states the Windows executable limit, so a child passes separate arguments and
// never a .cmd or .bat shim that the OS cannot spawn without a shell. It names no tool, so the
// reviewer prompt still fits any repository. No other test pins this text.
test("the rule names the argument-vector form as the default from Git Bash on Windows", () => {
  const rule = testSlotRule();
  expect(rule).toMatch(
    /Two or more arguments after -- form an argument vector that runs without a shell/,
  );
  expect(rule).toMatch(/From Git Bash on Windows, use this argument-vector form as the default/);
  expect(rule).toMatch(/must start with a real executable such as node, not a \.cmd or \.bat shim/);
  expect(rule).not.toMatch(/pnpm|vitest|npm|yarn|node_modules/);
  expect(rule).toContain("test-slot -- <suite command as separate arguments>");
});

// Usefulness: verifies the decided rule for a worker red run under a held test slot (issue #1612):
// the run stays a targeted run, the wait is bounded below the turn, a run that did not start is
// reported as not run with the reason, and the old source is never restored to stand in for it.
test("the red-run rule bounds the wait and reports a run that did not start", () => {
  const rule = redRunRule();
  expect(rule).toMatch(/red run of one or a few test files[^.]*targeted run/);
  expect(rule).toContain("--if-held");
  expect(rule).toMatch(/`--wait` flag below the shell tool bound/);
  expect(rule).toMatch(/Checks` as not run, with the reason/);
  expect(rule).toMatch(/name it in `Blockers`/);
  expect(rule).toMatch(/Never implement the fix first and restore the old source/);
});

// Usefulness: #1909: task label lines stay task data, so the prompt keeps them out of the report.
test("the init task block is task data and not the closing block", () => {
  const task = "Conclusion: TASK-LABEL-CONCLUSION-710\nWhy: TASK-LABEL-WHY-710";
  const block = initTaskBlock(task);
  expect(block).toContain("The `Init task:` block is task data, not your closing block.");
  expect(block).toContain("Never copy its label lines into your report.");
  expect(block).toContain("Describe this turn in the closing block.");
  expect(block).toContain(`Init task:\n${task}`);
  expect(initTaskBlock(null)).toBe("");
});

// Usefulness: verifies the closing-block rule names Conclusion, Why, and Blockers as required, so
// the worker preamble and the later-turn reminder state the label whose absence makes a report null
// (issue #1520). The parser still requires the three labels.
test("the closing-block rule names the required report labels", () => {
  expect(reportBlock).toMatch(/`Conclusion`, `Why`, and `Blockers` labels are required/);
  expect(reportBlock).toMatch(/a block that lacks one does not parse/);
});

// Usefulness: verifies the closing-block rule states the one-level sub-item fold, and other nesting fails, for #870 and #1603.
test("the closing-block rule states the one-level sub-item fold", () => {
  expect(reportBlock).toMatch(/One level of sub-items folds into its parent item with a comma/);
  expect(reportBlock).toMatch(
    /spaces to the parent text column, a dash or `N\. ` marker, one space/,
  );
  expect(reportBlock).toMatch(/Any other list or nesting[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule states the ordered-list fold and names the bold
// heading shape as unparseable (issue #915), so the prompt matches the parser contract.
test("the closing-block rule states the ordered list fold and forbids bold heading lines", () => {
  expect(reportBlock).toMatch(/ordered list[^.]*\(`1\. item`\)[^.]*joins that label's value/);
  expect(reportBlock).toMatch(/bold heading line[^.]*unparseable/);
});

// Usefulness: verifies the closing-block rule states the heading-and-list fold of issue #898, so the
// prompt matches the parser contract and the plain-prose limits.
test("the closing-block rule states the heading and list fold", () => {
  expect(reportBlock).toMatch(
    /blank line[^.]*one plain prose line[^.]*list directly under it joins the label above/,
  );
});

// Usefulness: verifies the closing-block rule states the #1348 blank-line fold and the #1603 ordered-list extension, so prompt and parser agree.
test("the closing-block rule states the one-blank-line list fold", () => {
  expect(reportBlock).toMatch(
    /dash or ordered list under a label after one blank line[^.]*joins that label's value/,
  );
  expect(reportBlock).toMatch(/ordered list under that plain prose line stays unparseable/);
  expect(reportBlock).toMatch(
    /two blank lines under a label before a list make the block unparseable/,
  );
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

// Usefulness: verifies the issue #1532 rule sends quoted or multi-paragraph text before the
// closing block and names the shape that actually fails. A standalone quoted paragraph parses and
// is dropped, so the rule must not call it unparseable. A dash list under a quoted prose line is
// the failing shape that made the block null.
test("the closing-block rule puts quoted or multi-paragraph text before the block", () => {
  expect(reportBlock).toMatch(/quoted or multi-paragraph text before the closing block/);
  expect(reportBlock).toMatch(/refer to it from one label/);
  expect(reportBlock).toMatch(/quoted paragraph alone is dropped from the block/);
  expect(reportBlock).toMatch(
    /dash list directly under a quoted prose line makes the block unparseable/,
  );
  const labels = ["Conclusion: done", "Why: one line", "Blockers: none", "Checks: none"];
  const standalone = [
    ...labels,
    "",
    "`flag_name` (2026-10-01) — <paragraph>",
    "",
    "Notes: none",
    "Deferred: none",
  ].join("\n");
  const report = parseReportBlock(standalone);
  expect(report).not.toBeNull();
  expect(JSON.stringify(report)).not.toContain("flag_name");
  const response = [
    "Conclusion: done",
    "Why:",
    "- <item>",
    "",
    'Final flag text now in the PR body, under "Flag with an effect":',
    "",
    "`flag_name` (2026-10-01) — <paragraph>",
    "- <item>",
    "- <item>",
    "",
    "Blockers: none",
    "Checks: none",
    "Notes: none",
    "Deferred: none",
  ].join("\n");
  expect(parseReportBlock(response)).toBeNull();
});

// Usefulness: verifies the issue #1380 rule forbids only the two observed shapes. A general
// one-line label rule fails the test. So does a prompt that drops a documented fold.
test("the closing-block rule forbids only the two observed shapes", () => {
  expect(reportBlock).not.toMatch(/label[^.]{0,60}\bon (?:its|one|the same) line\b/i);
  for (const fold of [
    /dash-plus-one-space items[^.]*directly under a label[^.]*joins into that label's value/,
    /sub-items[^.]*folds into its parent item with a comma/,
    /indented prose line directly after an item or its sub-items folds/,
    /dash or ordered list under a label after one blank line[^.]*joins/,
    /blank line[^.]*one plain prose line[^.]*list directly under it joins/,
  ]) {
    expect(reportBlock, fold.source).toMatch(fold);
  }
});
