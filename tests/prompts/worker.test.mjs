import { expect, test } from "vitest";
import { workerPrompt } from "../../src/prompts/worker.mjs";

// Usefulness: verifies the first worker turn asks for the closing report block
// (conclusion, why, blockers) plus the optional notes and deferred labels, so
// the orchestrator receives reasoning and out-of-scope items, not only an
// outcome (issue #49, issue #214).
test("first worker turn requires the closing report block", () => {
  const prompt = workerPrompt("do the task", true);
  expect(prompt).toContain("do the task");
  expect(prompt).toContain("Conclusion:");
  expect(prompt).toContain("Why:");
  expect(prompt).toContain("Blockers:");
  expect(prompt).toContain("Notes:");
  expect(prompt).toContain("Deferred:");
});

// Usefulness: verifies the first worker turn commits and pushes on the named PR
// branch for PR work, so the reviewer sees a committed head, the PR head matches
// that commit, and reviewed.clean can be true (issue #252).
test("first worker turn commits and pushes on the named PR branch for PR work", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain("For PR work, the dispatcher names the PR branch.");
  expect(prompt).toContain(
    "Commit your change on that branch and push it, so the reviewer sees a committed head and the PR head matches that commit.",
  );
  expect(prompt).toContain("A task is PR work when its change is delivered on a pull request.");
});

// Usefulness: verifies later worker turns stay raw; the session already holds the instructions.
test("later worker turns pass the prompt through unchanged", () => {
  expect(workerPrompt("next step", false)).toBe("next step");
});
