import { expect, test } from "vitest";
import { reviewerPrompt } from "../../src/prompts/reviewer.mjs";

// Usefulness: verifies every reviewer turn keeps the read-only guard and asks
// for the closing report block plus the optional notes and deferred labels, so
// the orchestrator receives the reviewer's reasoning and out-of-scope items
// (issue #49, issue #214).
test("reviewer prompt keeps the read-only guard and requires the closing report block", () => {
  const prompt = reviewerPrompt("check the tests");
  expect(prompt).toContain("Do not implement, fix, edit, or change any file.");
  expect(prompt).toContain("check the tests");
  expect(prompt).toContain("Conclusion:");
  expect(prompt).toContain("Why:");
  expect(prompt).toContain("Blockers:");
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
