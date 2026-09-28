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

// The role bullet that carries the branch rule. The bullet is located by the
// branch term, not by a whole sentence, so a same-meaning reword keeps the
// assertion and a dropped bullet fails the lookup (issue #252, issue #328).
function branchBullet(prompt) {
  const bullet = prompt
    .split(/\n\s*-\s/)
    .map((entry) => entry.replace(/\s+/g, " "))
    .find((entry) => /\bbranch\b/i.test(entry));
  expect(bullet, "the worker prompt states no branch rule").toBeTruthy();
  return bullet;
}

// The phrase a commit or push instruction targets: the preposition and the words
// after it, up to the next clause mark. The preposition may sit several words
// later, so "commit your change on that branch" and "commit on that branch" both
// match, and one instruction cannot read into the next. The determiner is
// captured with the phrase, so "on the main branch" yields "the main branch" and
// not the word "the" alone.
const TARGET =
  /\b(?:commit|push)\b[^.;]{0,60}?\b(?:on|onto|to)\s+([^,.;]{1,40}?)(?=\s+(?:and|so|but|to)\b|[,.;]|$)/gi;

// A determiner that points at a branch without naming one.
const DETERMINER = /^(?:the|a|an|that|this|your|its|it|each|every|which|one)\b\s*/i;

// A phrase that names no branch of its own: a determiner alone, as in "the", or
// the generic branch word with only a reference beside it, as in "that branch"
// and "the branch the dispatcher named". A phrase with a name in it is not one.
function genericBranch(phrase) {
  const rest = phrase.replace(DETERMINER, "").trim();
  if (rest === phrase.trim()) return false;
  return rest === "" || /^(?:branch|branches)\b/i.test(rest);
}

// The branches the commit and push instructions name, read out of the bullet.
function commitTargets(bullet) {
  return [...bullet.matchAll(TARGET)].map((match) => match[1].trim());
}

// Usefulness: verifies the first worker turn tells the worker to commit and push
// on the branch the dispatcher supplied, so the commit lands where the reviewer
// will look and the PR head matches the reviewed head (issue #252, issue #328).
test("first worker turn commits and pushes on the branch the dispatcher named", () => {
  const branch = "feat/328-prompt-test-literals";
  const prompt = workerPrompt(`land the change on ${branch}`, true);
  // The dispatcher supplies the branch through the task, so the prompt carries it.
  expect(prompt).toContain(branch);
  const bullet = branchBullet(prompt);
  const targets = commitTargets(bullet);
  expect(targets.length, "the branch rule names no commit or push target").toBeGreaterThan(0);
  // Every target is the supplied branch, or a reference back to it. A rule that
  // names another branch fails here.
  for (const target of targets) {
    expect(
      target === branch || genericBranch(target),
      `the rule commits on ${target}, not the supplied branch`,
    ).toBe(true);
  }
  for (const term of [/\bcommit\b/i, /\bpush\b/i, /pull request/i]) {
    expect(bullet, String(term)).toMatch(term);
  }
});

// Usefulness: verifies later worker turns stay raw; the session already holds the instructions.
test("later worker turns pass the prompt through unchanged", () => {
  expect(workerPrompt("next step", false)).toBe("next step");
});
