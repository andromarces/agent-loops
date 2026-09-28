import { expect, test } from "vitest";
import { parseReportBlock } from "../../src/lib/report.mjs";
import { workerPrompt } from "../../src/prompts/worker.mjs";

// A label line at column 0, for example
// `Checks: the commands that ran and their results, or "none". One line.`
const LABEL_LINE = /^([A-Z][A-Za-z]*):\s/;

// The closing block template the prompt renders: the blank-line separated
// paragraph that opens with a `Conclusion:` label, which is where the parser
// starts the block too. Only that paragraph is the block, so label text in the
// role bullets or in the task cannot stand in for a label the block dropped.
function closingBlockTemplate(prompt) {
  const block = prompt.split(/\n\s*\n/).find((text) => /^Conclusion:\s/m.test(text));
  if (!block) {
    throw new Error("the worker prompt renders no closing block template");
  }
  return block;
}

// A worker response written to the closing block: each label line holds the
// value the caller supplies, and every other line of the template is kept as
// written, so the sample parses under the same rules the prompt describes.
function workerResponse(block, values = {}) {
  return block
    .split("\n")
    .map((line) => {
      const label = LABEL_LINE.exec(line)?.[1];
      return label ? `${label}: ${values[label] ?? `${label} value.`}` : line;
    })
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
// orchestrator with a null checks field. The sample comes from the block alone,
// so a reword of the block keeps the assertion and a Checks label the block
// drops or renames fails it even when the word appears elsewhere in the prompt
// (issue #310, issue #318).
test("a worker response written to the prompt block parses a Checks value", () => {
  const block = closingBlockTemplate(workerPrompt("do the task", true));
  const report = parseReportBlock(workerResponse(block, { Checks: "pnpm test passed" }));
  expect(report).not.toBeNull();
  expect(report.checks).toBe("pnpm test passed");
});

// The rule-bearing clause of the PR-branch instruction: it commits on the branch
// the dispatcher named and pushes it. The branch is a back-reference, not a name,
// so a prompt that names a branch of its own fails this clause. A presence check
// on the key terms, so dropping the commit or the push fails too.
const COMMIT_ON_THE_NAMED_BRANCH =
  /commit[^.;]{0,60}?\b(?:on|onto)\s+(?:that|the)\s+branch\b[^.;]{0,40}?\bpush\b/i;

// A slash-shaped name, the shape a run reads as naming a branch, as in
// `origin/main`. The sentinel the task supplies is the only one allowed.
const BRANCH_NAME = /\b[\w-]+\/[\w./-]+/g;

// Usefulness: verifies the first worker turn tells the worker to commit and push
// on the branch the dispatcher supplied, so the commit lands where the reviewer
// will look and the PR head matches the reviewed head. The prompt is built with a
// unique sentinel branch, so a rule that names a branch of its own is caught
// (issue #252, issue #328).
test("first worker turn commits and pushes on the branch the dispatcher named", () => {
  const branch = "sentinel/328-branch-under-test";
  const prompt = workerPrompt(`land the change on ${branch}`, true);
  // The dispatcher supplies the branch, so the prompt carries it verbatim.
  expect(prompt).toContain(branch);
  // The instruction commits and pushes on that branch, by back-reference.
  expect(prompt).toMatch(COMMIT_ON_THE_NAMED_BRANCH);
  // No branch other than the sentinel is named anywhere in the prompt.
  const named = [...prompt.matchAll(new RegExp(BRANCH_NAME.source, "g"))].map((match) => match[0]);
  expect(
    named.filter((name) => name !== branch),
    "the prompt names a branch of its own",
  ).toEqual([]);
});

// Usefulness: verifies later worker turns stay raw; the session already holds the instructions.
test("later worker turns pass the prompt through unchanged", () => {
  expect(workerPrompt("next step", false)).toBe("next step");
});
