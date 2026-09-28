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

// The target of every commit or push instruction in the text: the phrase after
// the preposition, up to the next clause mark. A commit and a push in one clause
// each yield a target, so a second target naming another branch is caught.
const BRANCH_TARGET =
  /\b(?:commit|push)(?:s|es)?\b[^.;]{0,40}?\b(?:on|onto|to)\s+([^,.;]{1,40}?)(?=\s+(?:and|so|but)\b|[,.;]|$)/gi;

// A target that names a branch instead of pointing at the one the dispatcher
// supplied. A back-reference is a determiner and the word "branch" and nothing
// else, so `main` and `the main branch` each name a branch of their own.
const NAMED_TARGET = /^(?!\s*(?:the|that|this|your|its)\s+branch(?:es)?\s*$)\S/i;

// The commit instruction on the supplied branch, with BRANCH standing in for the
// branch the task supplied, so the rule may name it or point at it.
const COMMIT_ON_SUPPLIED_BRANCH =
  /commit[^.;]{0,60}?\b(?:on|onto)\s+(?:(?:the|that|this|your)\s+branch|BRANCH)/i;

/** Asserts the rule commits and pushes on the branch the dispatcher supplied. */
function expectBranchTargets(text, branch) {
  // The dispatcher supplies the branch, so the prompt must carry it.
  expect(text).toContain(branch);
  const flat = text.replace(/\s+/g, " ");
  // The commit instruction targets the supplied branch, named outright or pointed
  // at, and the push follows the commit, so dropping either fails.
  expect(flat, "the rule states no commit on the supplied branch").toMatch(
    new RegExp(COMMIT_ON_SUPPLIED_BRANCH.source.replace("BRANCH", branch), "i"),
  );
  expect(flat, "the rule states no push instruction").toMatch(/commit[^.;]{0,120}?\bpush\b/i);
  for (const target of commitTargets(flat)) {
    // A back-reference points at the supplied branch; a name of its own fails.
    expect(
      target === branch || !NAMED_TARGET.test(target),
      `the rule commits on ${target}, not the supplied branch`,
    ).toBe(true);
  }
}

/** Every commit or push target in the text, whitespace collapsed. */
function commitTargets(text) {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(new RegExp(BRANCH_TARGET.source, "gi"))].map((match) => match[1].trim());
}

// Usefulness: verifies the first worker turn tells the worker to commit and push
// on the branch the dispatcher supplied, so the commit lands where the reviewer
// will look and the PR head matches the reviewed head. The prompt is built with a
// unique sentinel branch, so a target naming any other branch, including a bare
// `main` or `origin/main`, fails (issue #252, issue #328).
test("first worker turn commits and pushes on the branch the dispatcher named", () => {
  const branch = "sentinel/328-branch-under-test";
  expectBranchTargets(workerPrompt(`land the change on ${branch}`, true), branch);
});

// Usefulness: verifies later worker turns stay raw; the session already holds the instructions.
test("later worker turns pass the prompt through unchanged", () => {
  expect(workerPrompt("next step", false)).toBe("next step");
});
