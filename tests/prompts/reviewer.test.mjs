import { expect, test } from "vitest";
import { reviewerPrompt } from "../../src/prompts/reviewer.mjs";

// Usefulness: verifies every reviewer turn keeps the read-only guard and asks
// for the closing report block plus the optional checks, notes, and deferred
// labels, so the orchestrator receives the reviewer's reasoning, reported
// checks, and out-of-scope items (issue #49, issue #214, issue #217).
test("reviewer prompt keeps the read-only guard and requires the closing report block", () => {
  const prompt = reviewerPrompt("check the tests");
  expect(prompt).toContain("Do not implement, fix, edit, or change any file.");
  expect(prompt).toContain("check the tests");
  expect(prompt).toContain("Conclusion:");
  expect(prompt).toContain("Why:");
  expect(prompt).toContain("Blockers:");
  expect(prompt).toContain("Checks:");
  expect(prompt).toContain("Notes:");
  expect(prompt).toContain("Deferred:");
});

// Usefulness: verifies every reviewer prompt traces a changed input, flag, or code path through
// the guards that consume it, so a weakened guard surfaces as a blocker (issue #216).
test("reviewer prompt traces changed inputs through existing guards", () => {
  const prompt = reviewerPrompt("check the fix");
  expect(prompt).toContain(
    "Trace each changed input, flag, or code path through the existing validators and guards that consume it.",
  );
});

// Usefulness: verifies the spec-challenge rule limits approval, so a restated spec never approves
// a weakened guard, and an approved change still names the affected guard or contract (issue #216).
test("reviewer prompt challenges a spec that weakens a guard and limits approval", () => {
  const prompt = reviewerPrompt("check the fix");
  expect(prompt).toContain(
    "Report a change that weakens an existing guard or documented contract as a blocker",
  );
  expect(prompt).toContain("Explicit approval names the guard or the contract.");
  expect(prompt).toContain(
    "A general requirement that weakens a guard as a side effect is not approval.",
  );
  expect(prompt).toContain("For an approved contract change, do not reject for the change itself.");
  expect(prompt).toContain(
    "Name the affected guard or contract in the report, and check that the docs and tests change with it.",
  );
});

// Usefulness: verifies the required-check rule is present in a task that names a
// pull request, so the reviewer reads the check status on the reviewed head
// instead of learning about a failure only at the finish gate (issue #313).
test("reviewer prompt carries the required-check rule for a task that names a pull request", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/gh pr checks .*--required/);
  expect(prompt).toMatch(/failing required check.*blocker/i);
  expect(prompt).toMatch(/pending/i);
  expect(prompt).toMatch(/no required check/i);
});

// Usefulness: verifies the required-check rule never lets an unread or
// mismatched check status read as a pass, so a missing `gh` or a PR head that
// differs from the local head is reported instead of assumed (issue #313).
test("reviewer prompt reports an unresolved check status instead of assuming a pass", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/cannot read the checks.*unresolved/i);
  expect(prompt).toMatch(/differs from the local reviewed head/i);
  expect(prompt).toMatch(/pass only when the read shows one/i);
});

// Usefulness: verifies the pull-request condition lives in the required-check
// bullet alone, so a scoping bullet cannot read as limiting the guard rules
// that follow it (issue #313).
test("only the required-check rule bullet limits itself to a task that names a pull request", () => {
  const prompt = reviewerPrompt("review the change");
  const scoped = prompt
    .split("\n")
    .filter((text) => text.startsWith("- ") && /pull request/i.test(text));
  expect(scoped).toHaveLength(1);
  expect(scoped[0]).toMatch(/gh pr checks/);
});

// Usefulness: verifies a read pass is reported as covering only the listed
// checks, because the command omits a check that has not started, so a partial
// read never reads as the whole required set (issue #313).
test("reviewer prompt limits a read pass to the checks the command listed", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/has not started/i);
  expect(prompt).toMatch(/only the listed checks/i);
});

// Usefulness: verifies a blocker needs a listed failing required check, so an
// exit code 1 that carries no such line is reported as unresolved instead
// (issue #313).
test("reviewer prompt requires a listed failing check before it reports a blocker", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/exit (code )?1/i);
  expect(prompt).toMatch(/blocker only when the output lists a failing required check/i);
  expect(prompt).toMatch(/any other exit (code )?1.*unresolved/i);
});
