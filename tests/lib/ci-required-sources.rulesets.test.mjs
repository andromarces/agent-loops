import { expect, test } from "vite-plus/test";
import { ABSENT, classifyRulesets, EMPTY, UNKNOWN } from "../../src/lib/ci-required-sources.mjs";
import { checkCi } from "../../src/lib/ci-gate.mjs";
import { equalsArgs, isPagedRead, pagedApiArgs, pageStdout } from "../gh-doubles.mjs";
import { fakeGh, HEAD, REVIEWED, routes, SLUG, run } from "./ci-gate-helpers.mjs";

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

// The ruleset read paginates, so a required-status-check rule can sit on a page the
// gate would not see if it read one. This is the read every page fixes (issue #336
// review).
const SECOND_PAGE_RULE = [
  {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
  },
];

// A `gh` double for the ruleset read that serves page `k` only to a request for page `k` by
// number, one request per page. A caller that reads the first page alone never sees the second
// page, so a read that stops early cannot be hidden by a double that always returns every page
// (issue #336 review). It replies only to the exact request, with the page number and
// `--include` as separate elements. Any other call, a merged-argument call or a `--paginate` call
// included, gets a failure that prints the arguments as an array (issue #538, #1033).
const RULESET = `repos/${SLUG}/rules/branches/main`;

function rulesetPages(pages) {
  return async (args) => {
    const page = pages.findIndex((_, i) => equalsArgs(args, pagedApiArgs(RULESET, i + 1)));
    if (page === -1) {
      return { status: 1, stdout: "", stderr: `unmatched gh call: ${JSON.stringify(args)}` };
    }
    return { status: 0, stdout: pageStdout(pages[page]), stderr: "" };
  };
}

const pageBody = ({ stdout }) => stdout.slice(stdout.indexOf("\r\n\r\n") + 4);

// A first page of 100 rules, which the read follows with a request for the next page.
const fullPage = (rules) => [
  ...rules,
  ...Array.from({ length: 100 - rules.length }, () => ({ type: "deletion" })),
];

// Usefulness: verifies the ruleset double serves a page only to the exact request for it, and gives
// no reply to a call that merges arguments into one element or that asks for `--paginate`
// (issue #538, #1033).
test("the ruleset double gives no reply to a merged-argument call", async () => {
  const read = rulesetPages([fullPage([]), SECOND_PAGE_RULE]);
  expect(JSON.parse(pageBody(await read(pagedApiArgs(RULESET, 1))))).toHaveLength(100);
  expect(JSON.parse(pageBody(await read(pagedApiArgs(RULESET, 2))))).toHaveLength(1);
  for (const bad of [
    ["api", RULESET, "--paginate", "--slurp"],
    ["api", `${RULESET}?per_page=100&page=1`, "--include", "--paginate"],
    ["api", `${RULESET}?per_page=100&page=1 --include`],
    ["api", `${RULESET}?per_page=100&page=3`, "--include"],
    [`api ${RULESET}?per_page=100&page=1`, "--include"],
  ]) {
    const reply = await read(bad);
    expect(reply.status).toBe(1);
    expect(reply.stdout).toBe("");
    expect(reply.stderr).toContain(JSON.stringify(bad));
  }
});

// Usefulness: verifies the gate gives the host lookup its variable list (#1046): the host that `gh`
// uses is read with `GH_TOKEN` and `GITHUB_TOKEN` dropped, so a `Link` header on the ruleset read that
// names the one configured host is no refusal. The double lists github.com unless both are dropped.
test("reads the gh default host without the token variables for a Link header", async () => {
  const base = fakeGh(routes({ required: [{ type: "deletion" }] }));
  const gh = async (args, cwd, options) => {
    if (args[0] === "auth") {
      const dropped = ["GH_TOKEN", "GITHUB_TOKEN"].every((name) =>
        options?.dropEnv?.includes(name),
      );
      const hosts = dropped ? ["ghe.example.com"] : ["ghe.example.com", "github.com"];
      const body = {
        hosts: Object.fromEntries(hosts.map((host) => [host, [{ host, tokenSource: "f" }]])),
      };
      return { status: 0, stdout: JSON.stringify(body), stderr: "" };
    }
    if (isPagedRead(args, "/rules/branches/main", 1)) {
      const link = 'Link: <https://ghe.example.com/api/v3/x?page=2>; rel="next"';
      return {
        status: 0,
        stdout: `HTTP/2.0 200 OK
${link}

${JSON.stringify([{ type: "deletion" }])}`,
        stderr: "",
      };
    }
    return base(args);
  };
  const result = await checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh });
  expect(result.reason ?? "").not.toMatch(/Link/);
});

// Usefulness: verifies a required-status-check rule that appears only on the second
// page is still enforced, so a read that stops at the first page cannot pass a
// branch that requires a check. The double serves the second page only to a request
// for that page number, so this fails when the read stops after the first page
// (issue #336 review).
test("reads every ruleset page before classifying the absence", async () => {
  const read = rulesetPages([fullPage([{ type: "deletion" }]), SECOND_PAGE_RULE]);
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: async (args) => {
      if (
        isPagedRead(args, "/rules/branches/main", 1) ||
        isPagedRead(args, "/rules/branches/main", 2)
      ) {
        return read(args);
      }
      return fakeGh(routes({ required: [{ type: "deletion" }] }))(args);
    },
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("ci (ubuntu-latest)");
  expect(result.noRequiredChecks).toBeUndefined();
});

// Usefulness: verifies the absence still holds when every page is read and no page
// names a required-status-check rule, so pagination did not turn the read into an
// unknown (issue #336 review).
test("records the absence when no page names a required-status rule", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        requiredPages: [fullPage([{ type: "deletion" }]), [{ type: "non_fast_forward" }]],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });
});

// An empty page beside a page that holds rules settles nothing, because GitHub
// stops paginating when there is no next page, so a partial read must not be
// classified from the pages that did arrive (issue #336 review). The page-number read hands the
// classifier every page it received, so a full page then an empty page keeps this class (#1033).
test("refuses the empty union when a ruleset page is empty beside a page with rules", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        requiredPages: [fullPage([{ type: "deletion" }]), []],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("repository rulesets");
  expect(result.noRequiredChecks).toBeUndefined();
});

// The page bodies the gate cannot account for every page of. Each is unknown
// rather than classified from the pages that arrived (issue #336 review).
const PARTIAL_PAGE_READS = {
  "a page that is an object": { requiredPages: [{ rules: [] }] },
  "a page that is null": { requiredPages: [null] },
  "a later page that is not a list": {
    requiredPages: [fullPage([{ type: "deletion" }]), { oops: true }],
  },
};

for (const [shape, { requiredPages }] of Object.entries(PARTIAL_PAGE_READS)) {
  // Usefulness: verifies ${shape} settles nothing, so a read the gate cannot
  // account for every page of keeps the empty-union refusal and names the source
  // (issue #336 review).
  test(`refuses the empty union and names the source on ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          requiredPages,
          protection: null,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok, `${shape} must not reach the absence path`).toBe(false);
    expect(result.reason).toContain("repository rulesets");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Only exactly one successful empty page says the branch has no rule. Every other
// empty pagination shape is an anomalous sequence or a read that returned nothing,
// so it is unknown and refuses (issue #336 review).
const ANOMALOUS_EMPTY_READS = {
  "an empty body from the paged read": { required: "" },
  "a full page then an empty page": { requiredPages: [fullPage([{ type: "deletion" }]), []] },
};

for (const [shape, override] of Object.entries(ANOMALOUS_EMPTY_READS)) {
  // Usefulness: verifies ${shape} is unknown rather than a successful empty read.
  // The fixture is a classic-only repository whose required check passed, so only
  // the ruleset outcome decides it: a single empty page finishes, and every other
  // empty shape refuses (issue #336 review).
  test(`refuses a classic-only repository on ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          protection: { required_status_checks: { contexts: ["ci (ubuntu-latest)"] } },
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
          ...override,
        }),
      ),
    });
    expect(result.ok, `${shape} must not be read as a successful empty read`).toBe(false);
    expect(result.reason).toContain("repository rulesets");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Usefulness: verifies a single empty page beside a page that holds rules is still
// unknown, so the anomalous rule is about the sequence and not only the count
// (issue #336 review). The shapes that a page-number read cannot produce, such as an empty page
// before a page with rules, are covered at the classifier in
// tests/lib/ci-required-sources.rulesets.test.mjs.
test("refuses the empty union when a page holding rules is followed by an empty page", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        requiredPages: [fullPage([{ type: "deletion" }]), []],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("repository rulesets");
  expect(result.noRequiredChecks).toBeUndefined();
});
