import { expect, test } from "vitest";
import { workerPrompt } from "../../src/prompts/worker.mjs";

// Usefulness: verifies the first worker turn asks for the closing report block (conclusion, why,
// blockers) so the orchestrator receives reasoning, not only an outcome (issue #49).
test("first worker turn requires the closing report block", () => {
  const prompt = workerPrompt("do the task", true);
  expect(prompt).toContain("do the task");
  expect(prompt).toContain("Conclusion:");
  expect(prompt).toContain("Why:");
  expect(prompt).toContain("Blockers:");
});

// Usefulness: verifies later worker turns stay raw; the session already holds the instructions.
test("later worker turns pass the prompt through unchanged", () => {
  expect(workerPrompt("next step", false)).toBe("next step");
});
