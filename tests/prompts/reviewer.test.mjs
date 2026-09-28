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

// Usefulness: verifies every reviewer prompt asks for the required-check status on
// the reviewed head when the task names a pull request, so a failing required
// check surfaces in the review instead of only at the finish gate (issue #313).
test("reviewer prompt reads the required checks for a task that names a pull request", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toContain("When the task names a pull request");
  expect(prompt).toContain("gh pr checks <pr> --required");
  expect(prompt).toContain("Report a failing required check as a blocker");
  expect(prompt).toContain("Report a pending required check in Checks");
});

// Usefulness: verifies the required-check rule tells the reviewer what to report
// when gh cannot read the checks, so an unread check status never reads as a
// pass (issue #313).
test("reviewer prompt reports an unread required-check status instead of a pass", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toContain("When gh cannot read the checks, report that in Checks");
  expect(prompt).toContain("Never report that the checks passed");
});

// Usefulness: verifies the required-check rule is scoped to a task that names a
// pull request, so a task without one is not asked for a check status
// (issue #313).
test("reviewer prompt limits the required-check rule to a task that names a pull request", () => {
  const prompt = reviewerPrompt("review the change");
  expect(prompt).toContain("This rule does not apply when the task names no pull request");
});
