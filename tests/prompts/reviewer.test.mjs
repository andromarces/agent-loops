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

const FAILING_READ = {
  pr: 42,
  status: "failing",
  checks: ["ci (macos-latest)"],
  summary: "failing required checks: ci (macos-latest)",
};
const UNREADABLE_READ = { pr: 42, status: "unresolved", checks: [], summary: "unread: exit 1" };

// Usefulness: verifies a supplied status reaches the reviewer prompt with its
// pull request and the failing check named, so a reviewer whose turn cannot reach
// the network still sees the failure the finish gate would refuse (issue #320).
test("reviewer prompt carries the runtime-read status and the pull request it names", () => {
  const prompt = reviewerPrompt("review the change", FAILING_READ);
  expect(prompt).toContain("42");
  expect(prompt).toContain("ci (macos-latest)");
  expect(prompt).toContain(FAILING_READ.summary);
});

// Usefulness: verifies the reviewer read stays the fallback, so a supplied
// status never removes the only read a reviewer can make on its own (issue #320).
test("reviewer prompt keeps its own read as the fallback for a supplied status", () => {
  const prompt = reviewerPrompt("review the change", UNREADABLE_READ);
  expect(prompt).toMatch(/gh pr checks .*--required/);
  expect(prompt).toMatch(/fallback/i);
  expect(prompt).toMatch(/unresolved/i);
});

// Usefulness: verifies a supplied status keeps every later scope line nested
// under the pull request condition, because an unnested line reads as an
// unconditional rule and narrows the guard rules above it (issue #317, #320).
test("a supplied status keeps the required-check bullets nested", () => {
  const lines = reviewerScopeOf(reviewerPrompt("review the change", FAILING_READ)).split("\n");
  const group = requiredCheckGroup(lines);
  expect(group).not.toBeNull();
  for (const text of lines.slice(group.start + 1)) {
    expect(text).toMatch(/^ {2,}- /);
  }
});

// Usefulness: verifies a supplied status adds no pull request mention outside
// the required-check group, so it cannot narrow an earlier guard rule
// (issue #317, #320).
test("a supplied status mentions a pull request only inside the required-check group", () => {
  const scope = reviewerScopeOf(reviewerPrompt("review the change", FAILING_READ));
  expect(prMentionsOutsideGroup(scope)).toEqual([]);
});

// Usefulness: verifies a run with no read supplies no status, so a prompt never
// carries a status the runtime did not read (issue #320).
test("reviewer prompt carries no status line without a read", () => {
  expect(reviewerPrompt("review the change")).not.toContain(FAILING_READ.summary);
});

// Usefulness: verifies a supplied status is marked advisory with the finish gate
// named as the enforcement point, because the runtime reads the head and the
// checks in separate calls, so a head that advances and returns between them
// cannot be told apart from a stable one and the status can describe a commit
// other than the reviewed head. The reviewer must treat it as evidence and the
// `--require-ci` gate, which re-reads GitHub, is what enforces
// (issue #320 review, third round).
test("a supplied status is advisory and the finish gate is the enforcement point", () => {
  const prompt = reviewerPrompt("review the change", FAILING_READ);
  expect(prompt).toMatch(/advisory/i);
  expect(prompt).toMatch(/--require-ci/);
  expect(prompt).toMatch(/re-reads GitHub|enforces/i);
});

// Usefulness: verifies the supplied status does not leave the fixed rule and the
// supplied lines ordering a read and a not-read at the same time, which is the
// contradiction a probe found: the scope tells the reviewer to read the checks
// and the supplied line tells it not to read them again, with no condition that
// separates the two (issue #320 review, third round).
test("a supplied status does not contradict the rule that orders the read", () => {
  const lines = reviewerScopeOf(reviewerPrompt("review the change", FAILING_READ)).split("\n");
  const group = requiredCheckGroup(lines);
  // The one line that orders the read is the group's own command bullet; a
  // supplied line must scope itself to the status it supplies, not restate the
  // order to read.
  const orderingRead = lines.filter(
    (text, index) => /read the required checks/.test(text) && index === group.start,
  );
  expect(orderingRead).toHaveLength(1);
  const supplied = lines.slice(group.start + 1);
  // The supplied lines replace the group's read rather than sitting beside it.
  expect(supplied.join("\n")).toMatch(/in place of|instead of|rather than/i);
  // A supplied line that mentions reading the checks must scope that read to a
  // condition. An unscoped read is the contradiction: a bare "keep your own read
  // as the fallback" beside "read the required checks" tells the reviewer to read
  // and not to read in the same breath.
  for (const text of supplied) {
    if (!/read the required checks/.test(text)) {
      continue;
    }
    expect(text, text.trim().slice(0, 80)).toMatch(
      /when the supplied status is unresolved|in place of|instead of|rather than/i,
    );
  }
  // And no line forbids the read outright, which would contradict the fallback.
  expect(supplied.join("\n")).not.toMatch(/without reading it again|do not read/);
});
