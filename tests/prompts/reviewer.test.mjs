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
