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

// Usefulness: verifies the reviewer block carries exactly one Checks line, so
// the shared closing block and the reviewer block do not duplicate the label
// after the worker block gained one (issue #310).
test("reviewer prompt carries one Checks line", () => {
  const prompt = reviewerPrompt("check the tests");
  expect(prompt.split("Checks:")).toHaveLength(2);
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

// Usefulness: verifies the required-check rule is present in a task that names a
// pull request, so the reviewer reads the check status on the reviewed head
// instead of learning about a failure only at the finish gate (issue #313).
test("reviewer prompt carries the required-check rule for a task that names a pull request", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/gh pr checks .*--required/);
  expect(prompt).toMatch(/failing required check.*blocker/i);
  expect(prompt).toMatch(/pending/i);
  expect(prompt).toMatch(/no required check/i);
});

// Usefulness: verifies the required-check rule never lets an unread or
// mismatched check status read as a pass, so a missing `gh` or a PR head that
// differs from the local head is reported instead of assumed (issue #313).
test("reviewer prompt reports an unresolved check status instead of assuming a pass", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/cannot read the checks.*unresolved/i);
  expect(prompt).toMatch(/differs from the local reviewed head/i);
  expect(prompt).toMatch(/pass only when the read shows one/i);
});

const namesPullRequest = (text) => /\bprs?\b/i.test(text) || /pull[ -]requests?/i.test(text);

// The fixed review scope as rendered, from the scope header to the closing
// report block. The scope has no blank line of its own, so slicing at the first
// one would drop a scoping line placed after one.
const reviewerScopeOf = (prompt) => {
  const start = prompt.indexOf("Review scope");
  const end = prompt.indexOf("End your response with this block");
  return prompt.slice(start, end < 0 ? undefined : end).trimEnd();
};

// The required-check group: the bullet that names the read command plus every
// nested sub-bullet under it. Any other line of the scope reads as a rule of its
// own, so a pull request mention there narrows an earlier rule.
const requiredCheckGroup = (lines) => {
  const start = lines.findIndex((text) => /gh pr checks/.test(text));
  if (start < 0) {
    return null;
  }
  let end = start;
  while (end + 1 < lines.length && /^ {2,}- /.test(lines[end + 1])) {
    end += 1;
  }
  return { start, end };
};

// Every line of the scope that names a pull request outside the group, in any
// line shape, so a scoping bullet, a scoping sentence, and a line past a blank
// line all fail the check.
const prMentionsOutsideGroup = (scope) => {
  const lines = scope.split("\n");
  const group = requiredCheckGroup(lines);
  return lines
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => namesPullRequest(text))
    .filter(({ index }) => !group || index < group.start || index > group.end)
    .map(({ text }) => text.trim());
};

// Usefulness: verifies only the required-check rule mentions a pull request, so
// a standalone scoping line cannot read as limiting the guard rules that
// follow it (issue #313, issue #317).
test("only the required-check rule mentions a pull request", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change"));
  expect(prMentionsOutsideGroup(scope)).toEqual([]);
});

// Usefulness: verifies the required-check bullets sit under the pull request
// condition as one group, so no later line of the scope reads as unconditional
// (issue #317).
test("the required-check bullets sit under the pull request condition", () => {
  const lines = reviewerScopeOf(reviewerPrompt("review the change")).split("\n");
  const group = requiredCheckGroup(lines);
  expect(group).not.toBeNull();
  expect(lines.length).toBeGreaterThan(group.start + 1);
  for (const text of lines.slice(group.start + 1)) {
    expect(text).toMatch(/^ {2,}- /);
  }
});

// Usefulness: verifies the pull request scoping check catches a scoping bullet
// placed after the required-check group, which the earlier check accepted
// because every bullet sat at or after the gh pr checks bullet (issue #317).
test("the pull request scoping check catches a scoping bullet after the group", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change"));
  const after = "- Read the merge box on a PR before the review.";
  expect(prMentionsOutsideGroup(`${scope}\n${after}`)).toEqual([after]);
});

// Usefulness: verifies the pull request scoping check matches `pr` in any
// spelling, which the earlier check missed because it was case-sensitive
// (issue #317).
test("the pull request scoping check catches a lowercase pr bullet", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change"));
  const after = "- Name the pr branch in the report.";
  expect(prMentionsOutsideGroup(`${scope}\n${after}`)).toEqual([after]);
});

// Usefulness: verifies the pull request scoping check reads every line of the
// review scope, not only its bullets, so a scoping sentence in the scope cannot
// escape the check (issue #317).
test("the pull request scoping check catches a scoping sentence that is not a bullet", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change"));
  const after = "A pull request always needs a reviewer.";
  expect(prMentionsOutsideGroup(`${scope}\n${after}`)).toEqual([after]);
});

// Usefulness: verifies the pull request scoping check reads the review scope to
// its end, so a blank line does not cut the scan short and let a scoping bullet
// through (issue #317).
test("the pull request scoping check catches a scoping bullet after a blank line", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change"));
  const after = "- Read the merge state of the PR before the review.";
  expect(prMentionsOutsideGroup(`${scope}\n\n${after}`)).toEqual([after]);
});

// Usefulness: verifies a read pass is reported as covering only the listed
// checks, because the command omits a check that has not started, so a partial
// read never reads as the whole required set (issue #313).
test("reviewer prompt limits a read pass to the checks the command listed", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/has not started/i);
  expect(prompt).toMatch(/only the listed checks/i);
});

// Usefulness: verifies a blocker needs a listed failing required check, so an
// exit code 1 that carries no such line is reported as unresolved instead
// (issue #313).
test("reviewer prompt requires a listed failing check before it reports a blocker", () => {
  const prompt = reviewerPrompt("review PR 313");
  expect(prompt).toMatch(/exit (code )?1/i);
  expect(prompt).toMatch(/blocker only when the output lists a failing required check/i);
  expect(prompt).toMatch(/any other exit (code )?1.*unresolved/i);
});
