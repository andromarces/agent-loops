import { expect, test } from "vitest";
import { parseReportBlock } from "../../src/lib/report.mjs";
import { workerPrompt } from "../../src/prompts/worker.mjs";

// A label line the prompt renders, for example
// `Checks: the commands that ran and their results, or "none". One line.`
const LABEL_LINE = /^([A-Z][A-Za-z]*):\s/;

// A worker response written to the closing block the prompt renders: every
// label line in the prompt, each holding the value the caller supplies. A label
// the parser does not read is carried as prose and ignored, so only the labels
// the block lists shape the result.
function workerResponse(prompt, values = {}) {
  return prompt
    .split("\n")
    .map((line) => {
      const label = LABEL_LINE.exec(line)?.[1];
      return label ? `${label}: ${values[label] ?? `${label} value.`}` : null;
    })
    .filter((line) => line !== null)
    .join("\n");
}

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

// Usefulness: verifies a worker response written to the closing block the
// prompt renders carries a Checks value the parser reads into report.checks, so
// a worker reports the commands it ran and their results instead of leaving the
// orchestrator with a null checks field. The sample follows whatever labels the
// block renders, so a reword of the block keeps the assertion and a dropped
// Checks label fails it (issue #310, issue #318).
test("a worker response written to the prompt block parses a Checks value", () => {
  const prompt = workerPrompt("do the task", true);
  const report = parseReportBlock(workerResponse(prompt, { Checks: "pnpm test passed" }));
  expect(report).not.toBeNull();
  expect(report.checks).toBe("pnpm test passed");
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
