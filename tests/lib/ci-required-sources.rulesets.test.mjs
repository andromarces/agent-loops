import { expect, test } from "vite-plus/test";
import { ABSENT, classifyRulesets, EMPTY, UNKNOWN } from "../../src/lib/ci-required-sources.mjs";

const RULE = { type: "deletion" };
const REQUIRED = {
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
};

// Usefulness: verifies the ADR 0012 class of every page sequence the classifier is handed, including
// the sequences that a page-number read cannot produce, so the allowlist keeps its fail-closed rows
// whatever the pager does (issue #336 review, #1033).
test.each([
  ["no page at all", [], UNKNOWN],
  ["exactly one empty page", [[]], EMPTY],
  ["two empty pages", [[], []], UNKNOWN],
  ["three empty pages", [[], [], []], UNKNOWN],
  ["an empty page beside a page that holds rules", [[RULE], []], UNKNOWN],
  ["an empty page before a page that holds rules", [[], [RULE]], UNKNOWN],
  ["an empty page before a page that holds a required rule", [[], [REQUIRED]], UNKNOWN],
  ["a body that is not the array of pages", { rules: [] }, UNKNOWN],
  ["a page that is not an array", [[RULE], { oops: true }], UNKNOWN],
  ["a page that is null", [[RULE], null], UNKNOWN],
  ["pages that are objects", [RULE, { oops: true }], UNKNOWN],
  ["one page of rules with no required rule", [[RULE]], ABSENT],
  ["two pages of rules with no required rule", [[RULE], [RULE]], ABSENT],
])("classifies %s", (_name, pages, state) => {
  expect(classifyRulesets(pages).state).toBe(state);
});

// Usefulness: verifies a required-status-check rule on a later page is still named, so a branch
// that requires a check is never read as an absence.
test("names a required check that sits on a later page", () => {
  expect(classifyRulesets([[RULE], [REQUIRED]]).contexts).toEqual([
    { name: "ci (ubuntu-latest)", appId: undefined },
  ]);
});
