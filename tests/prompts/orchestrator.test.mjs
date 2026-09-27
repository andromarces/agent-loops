import { expect, test } from "vitest";
import { initialPrompt, repairPrompt, resultPrompt } from "../../src/prompts/orchestrator.mjs";

// Usefulness: verifies initialPrompt produces exact expected string structure.
test("initialPrompt produces expected orchestrator prompt", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("You are the orchestrator in an automated multi-agent coding loop.");
  expect(prompt).toContain("maximum step budget of 10 steps");
  expect(prompt).toContain("Implement feature X");
  expect(prompt).toContain('{"action": "run_worker", "prompt": "<instructions for worker>"}');
});

// Usefulness: verifies the headless prompt states the notes and deferred finish
// mapping that the interactive instructions also carry: carry deferred items
// forward, record resolved ones in changed, map unaddressed notes to open, and
// split review-only findings between open and deferred (issue #214).
test("initialPrompt states the notes and deferred finish mapping", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("Each child turn ends with a closing report block");
  expect(prompt).toContain("Carry each Deferred item forward");
  expect(prompt).toContain("record it in changed");
  expect(prompt).toContain("Reviewer Notes that no later turn addressed go into open");
  expect(prompt).toContain("obtain another reviewer accept on the new state before finish");
  expect(prompt).toContain("In review-only mode, Blockers and Notes go into open");
  expect(prompt).toContain("deferred holds out-of-scope items in every mode");
});

// Usefulness: verifies the headless parent names the guards and contracts at risk
// in a reviewer prompt and does not restate the spec as the pass condition,
// matching the interactive reviewer-prompt rule (issue #228).
test("initialPrompt states the reviewer-prompt guard and contract rule", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain(
    "name the guards and contracts that the change puts at risk, so the reviewer can trace each changed input through them",
  );
  expect(prompt).toContain(
    "Do not restate the spec as the pass condition: a restated spec asks the reviewer to confirm it, not to test it",
  );
});

// Usefulness: verifies resultPrompt produces expected formatted payload for ok result.
test("resultPrompt produces expected prompt for ok result", () => {
  const prompt = resultPrompt({
    result: { role: "worker", status: "ok", response: "all done" },
    stepsUsed: 2,
    maxSteps: 5,
  });
  expect(prompt).toContain('"role": "worker"');
  expect(prompt).toContain('"status": "ok"');
  expect(prompt).toContain('"response": "all done"');
  expect(prompt).toContain('"stepsUsed": 2');
  expect(prompt).toContain('"stepsRemaining": 3');
});

// Usefulness: verifies resultPrompt produces expected formatted payload for error result.
test("resultPrompt produces expected prompt for error result", () => {
  const prompt = resultPrompt({
    result: { role: "reviewer", status: "error", error: "timed out" },
    stepsUsed: 1,
    maxSteps: 1,
  });
  expect(prompt).toContain('"role": "reviewer"');
  expect(prompt).toContain('"status": "error"');
  expect(prompt).toContain('"error": "timed out"');
  expect(prompt).toContain('"stepsRemaining": 0');
});

// Usefulness: verifies repairPrompt states the error and formats the repair request.
test("repairPrompt produces expected repair prompt", () => {
  const prompt = repairPrompt("Unsupported action: foo");
  expect(prompt).toContain("Unsupported action: foo");
  expect(prompt).toContain('{"action": "run_worker", "prompt": "<string>"}');
});
