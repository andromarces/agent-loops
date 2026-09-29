import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { checkCi, readRequiredChecks, runGh } from "../../src/lib/ci-gate.mjs";
import { removePath } from "../runtime-helpers.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const MERGE = "2222222222222222222222222222222222222222";

function prInfo(overrides = {}) {
  return {
    headRefOid: HEAD,
    baseRefName: "main",
    mergeStateStatus: "CLEAN",
    potentialMergeCommit: { oid: MERGE },
    state: "OPEN",
    ...overrides,
  };
}

const REQUIRED = [
  {
    type: "required_status_checks",
    parameters: {
      required_status_checks: [
        { context: "ci (ubuntu-latest)" },
        { context: "ci (windows-latest)" },
      ],
    },
  },
];

function run(name, conclusion) {
  return {
    name,
    status: "completed",
    conclusion,
    started_at: "2026-01-01T00:00:00Z",
  };
}

// Routes a `gh` call by a substring of its arguments. A `hidden` value answers
// with the 404 a token without repository admin receives, a `forbidden` value
// with the 403 a `GITHUB_TOKEN` receives, a `pat forbidden` value with the 403 a
// fine-grained PAT without the Administration permission receives, a
// `rate limited` value with a 403 that is not an unreadable-source answer. A
// `stderr: <text>` value fails with that exact stderr, which covers the Free-plan
// 403 and every other reply shape a named value does not. An unmatched call is
// an error so a test never passes on a missing fixture. `null` is the admin
// reply for a branch with no classic protection, which is also unreadable but
// says so differently.
function fakeGh(routes) {
  return async (args) => {
    const key = args.join(" ");
    for (const [match, value] of routes) {
      if (key.includes(match)) {
        if (value === null) {
          return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
        }
        if (value === "hidden") {
          return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
        }
        if (value === "forbidden") {
          return {
            status: 1,
            stdout: "",
            stderr: "gh: Resource not accessible by integration (HTTP 403)",
          };
        }
        if (value === "pat forbidden") {
          return {
            status: 1,
            stdout: "",
            stderr: "gh: Resource not accessible by personal access token (HTTP 403)",
          };
        }
        if (value === "rate limited") {
          return { status: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 403)" };
        }
        if (typeof value === "string" && value.startsWith("stderr: ")) {
          return { status: 1, stdout: "", stderr: value.slice("stderr: ".length) };
        }
        if (typeof value === "string") {
          return { status: 0, stdout: value, stderr: "" };
        }
        return { status: 0, stdout: JSON.stringify(value), stderr: "" };
      }
    }
    return { status: 1, stdout: "", stderr: `unmatched gh call: ${key}` };
  };
}

function routes({
  info = prInfo(),
  mergeRuns = [],
  mergeStatuses = [],
  headRuns = [],
  headStatuses = [],
  required = REQUIRED,
  // The paginated ruleset body verbatim, for a read that spans pages. `required`
  // is wrapped in one page, so a test that needs a rule on a later page passes
  // `requiredPages` instead of nesting arrays by hand.
  requiredPages = null,
  protection = null,
  prChecks = [],
} = {}) {
  return [
    ["pr view 42", info],
    ["pr checks 42", prChecks],
    ["repo view", "andromarces/agent-loops"],
    // The ruleset read is paginated, so its body is an array of pages.
    ["rules/branches/main", requiredPages ?? (Array.isArray(required) ? [required] : required)],
    ["branches/main/protection", protection],
    [`commits/${MERGE}/check-runs`, [{ check_runs: mergeRuns }]],
    [`commits/${MERGE}/status`, { statuses: mergeStatuses }],
    [`commits/${HEAD}/check-runs`, [{ check_runs: headRuns }]],
    [`commits/${HEAD}/status`, { statuses: headStatuses }],
  ];
}

const REVIEWED = { head: HEAD, clean: true, exact: true, digest: "d" };

// The exact reply a private repository on the GitHub Free plan writes to the
// required-context API endpoints (#301).
const FREE_PLAN =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

// The one trailing line break `gh` may add to a reply, and the shapes it may add
// that are not the whole reply.
const ENDINGS = { "no line ending": "", LF: "\n", CRLF: "\r\n" };

// Usefulness: verifies the gate passes when every required check run passed on
// the head commit and the PR matches the reviewed state (issue #218).
test("passes when every required check passed on the head commit", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "skipped")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies the gate evaluates the test merge commit when it carries
// a status, so a failing required check there refuses even though the head
// commit passed (issue #218).
test("evaluates the test merge commit when it carries a status", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        mergeRuns: [run("ci (ubuntu-latest)", "failure")],
        headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("ci (ubuntu-latest)");
  expect(result.reason).toContain("failure");
});

// Usefulness: verifies a required name that is a pending check run fails the
// gate (issue #218).
test("refuses a pending required check run", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        headRuns: [
          {
            name: "ci (ubuntu-latest)",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-01-01T00:00:00Z",
          },
          run("ci (windows-latest)", "success"),
        ],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("pending");
});

// Usefulness: verifies a required name with no check run or commit status is
// missing and fails the gate (issue #218).
test("refuses a missing required check", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(routes({ headRuns: [run("ci (ubuntu-latest)", "success")] })),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("ci (windows-latest)");
  expect(result.reason).toContain("missing");
});

// Usefulness: verifies a required commit status that failed refuses the gate
// (issue #218).
test("refuses a failing required commit status", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "legacy" }] },
          },
        ],
        headStatuses: [{ context: "legacy", state: "failure", updated_at: "2026-01-01T00:00:00Z" }],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("legacy");
  expect(result.reason).toContain("commit status failure");
});

// Usefulness: verifies that when a check run and a commit status share a
// required name, the passing check run cannot cover the failing commit status
// (issue #218).
test("refuses when a check run and a commit status share a required name and one fails", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci (ubuntu-latest)" }] },
          },
        ],
        headRuns: [run("ci (ubuntu-latest)", "success")],
        headStatuses: [
          { context: "ci (ubuntu-latest)", state: "failure", updated_at: "2026-01-01T00:00:00Z" },
        ],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("commit status failure");
});

// Usefulness: verifies the gate refuses a PR that is behind its base under a
// strict rule (issue #218).
test("refuses a PR behind its base", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(routes({ info: prInfo({ mergeStateStatus: "BEHIND" }) })),
  });
  expect(result).toEqual({ ok: false, reason: "the PR is behind its base branch" });
});

// Usefulness: verifies the gate refuses an unknown merge state, which GitHub
// computes lazily, and names that a retry can succeed (issue #218).
test("refuses an unknown merge state", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(routes({ info: prInfo({ mergeStateStatus: "UNKNOWN" }) })),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("merge state as unknown");
});

// Usefulness: verifies the gate passes on a base branch whose two configuration
// sources stated it holds no required check, and records the absence so a finish
// on such a branch stays distinct from a gated pass on a branch that required a
// check (issue #336). The ruleset reply is a non-empty array of well-formed rules
// with no required-status-check rule, which is the shape that states the outcome.
test("passes and records the absence when no required check exists", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({ required: [{ type: "deletion" }], headRuns: [run("reported-pass", "success")] }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });
});

// Usefulness: verifies an established absence still refuses a blocked merge
// state, so the relaxed empty union cannot pass a pull request that some other
// required rule blocks (issue #336).
test("refuses a blocked merge state when no required check exists", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [{ type: "deletion" }],
        headRuns: [run("ci (ubuntu-latest)", "failure")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("blocked");
});

// The reply shapes that leave a required-check configuration source empty
// without proving it holds no required check. Each must keep the empty-union
// refusal and name the source, because each is a reply this caller cannot read
// rather than a statement about the branch (issue #336 review). The read-only
// probe behind each is recorded in the ADR.
//
// A rate-limit or SSO 403 is deliberately not in this list. That reply matches no
// unreadable shape, so the gate throws on it and fails the run, which is stricter
// than a refusal and cannot reach the relaxed path (issue #280).
const UNKNOWN_SHAPES = {
  "a 404 Not Found for a token without admin": {
    protection: "hidden",
    why: "a non-admin answers the same endpoint for an unprotected branch and for a protected one it may not read",
  },
  "a 403 from a GITHUB_TOKEN": {
    protection: "forbidden",
    why: "the integration credential is refused before the branch is read",
  },
  "a 403 from a fine-grained PAT without Administration": {
    protection: "pat forbidden",
    why: "the PAT reads the repository but not its protection settings",
  },
  "the Free-plan 403": {
    protection: `stderr: ${FREE_PLAN}`,
    why: "it names the plan, and it is written the same way for a branch that exists and one that does not",
  },
};

for (const [shape, { protection, why }] of Object.entries(UNKNOWN_SHAPES)) {
  // Usefulness: verifies an empty union resting on ${shape} still refuses and
  // names ${why}, so a read-only probe cannot be read as a base branch with no
  // required check and a parent learns which source to fix (issue #336 review).
  test(`refuses the empty union and names the source on ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: [],
          protection,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.reason, why).toContain("no required checks were found");
    expect(result.reason, why).toContain("classic branch protection");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Usefulness: verifies the same on the ruleset source, so a caller that cannot
// read repository rulesets is named too and the refusal is not attributed to the
// wrong endpoint (issue #336 review).
test("refuses the empty union and names the source when repository rulesets cannot be read", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: `stderr: ${FREE_PLAN}`,
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  // A ruleset-unknown refusal names the source and does not claim that no required
  // checks were found, because the union may be non-empty.
  expect(result.reason).toContain("repository rulesets");
});

// The replies the code accepted as a positive absence that do not prove one, so
// each is reclassified to unknown. Each entry records why the reply settles
// nothing about the branch (issue #336 review).
const AMBIGUOUS_ABSENCE_SHAPES = {
  "an empty ruleset array": {
    required: [],
    why: "it is the same reply for a branch no ruleset applies to and for a caller or endpoint that enumerates no rule for this branch",
  },
  "a `Branch not protected` message inside another error": {
    protection: "stderr: gh: failed to fetch: gh: Branch not protected (HTTP 404)",
    why: "the same text quoted inside a larger error says nothing about the branch",
  },
  "a `Branch not protected` message beside a second line": {
    protection: "stderr: gh: Branch not protected (HTTP 404)\ngh: failed to fetch: no such host",
    why: "a second error beside it means the reply is not the endpoint's own",
  },
  "a `Branch not protected` message with text after the status": {
    protection: "stderr: gh: Branch not protected (HTTP 404): retry later",
    why: "trailing text is not the reply the endpoint writes",
  },
};

for (const [shape, { required, protection, why }] of Object.entries(AMBIGUOUS_ABSENCE_SHAPES)) {
  // Usefulness: verifies ${shape} is unknown rather than an absence, so a reply
  // that ${why} cannot pass a finish, and the refusal names the source
  // (issue #336 review).
  test(`refuses the empty union and names the source on ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: required ?? [{ type: "deletion" }],
          protection: protection ?? null,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok, `${shape} must not reach the absence path`).toBe(false);
    expect(result.reason, why).toMatch(
      required === undefined ? /classic branch protection/ : /repository rulesets/,
    );
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Usefulness: verifies the exact `Branch not protected` 404 still proves the
// absence, one trailing line break aside, so anchoring the match to the whole
// reply did not cost the one reply that states the outcome (issue #336 review).
for (const [ending, suffix] of Object.entries(ENDINGS)) {
  // Usefulness: verifies the exact 404 with ${ending} is still an absence, the one
  // trailing break `gh` may add included (issue #336 review).
  test(`reads the exact Branch not protected 404 with ${ending} as an absence`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          // Both sources must state the absence, so the ruleset read is a non-empty
          // array of well-formed rules with no required-status-check rule.
          required: [{ type: "deletion" }],
          protection: `stderr: gh: Branch not protected (HTTP 404)${suffix}`,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });
  });
}

// Usefulness: verifies an empty `gh pr checks --required` output never establishes
// the absence on its own: it lists only the checks that already reported, so its
// silence is the same silence as a read failure, and a source that settles nothing
// still refuses (issue #336 review).
test("an empty gh pr checks reply does not establish the absence on its own", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [{ type: "deletion" }],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  // The two configuration sources stated the outcome, so this passes, and the
  // absence rests on them rather than on the empty required-names read.
  expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });

  // The same empty required-names read beside a source that settles nothing
  // refuses, which is what shows the emptiness establishes nothing.
  const refused = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(refused.ok).toBe(false);
  expect(refused.reason).toContain("repository rulesets");
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

// A `gh` double for the ruleset read that serves every page only when the caller
// actually asks for them. A caller that reads one page receives the first page
// alone, so a missing `--paginate --slurp` cannot be hidden by a double that always
// returns every page (issue #336 review).
function rulesetPages(pages) {
  return async (args) => {
    const key = args.join(" ");
    const paginated = key.includes("--paginate") && key.includes("--slurp");
    return {
      status: 0,
      stdout: JSON.stringify(paginated ? pages : [pages[0]]),
      stderr: "",
    };
  };
}

// Usefulness: verifies a required-status-check rule that appears only on the second
// page is still enforced, so a read that stops at the first page cannot pass a
// branch that requires a check. The double serves the second page only to a caller
// that requested pagination, so this fails when `--paginate --slurp` is removed
// (issue #336 review).
test("reads every ruleset page before classifying the absence", async () => {
  const read = rulesetPages([[{ type: "deletion" }], SECOND_PAGE_RULE]);
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: async (args) => {
      const key = args.join(" ");
      if (key.includes("rules/branches/main")) {
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
        requiredPages: [[{ type: "deletion" }], [{ type: "non_fast_forward" }]],
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
// classified from the pages that did arrive (issue #336 review).
test("refuses the empty union when a ruleset page is empty beside a page with rules", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        requiredPages: [[{ type: "deletion" }], []],
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

// An unknown ruleset read must refuse whatever the rest of the union holds, because
// that reply may carry a required-status rule this caller never saw, and a
// non-empty union from another source would otherwise let the per-check pass judge
// only the names it saw (issue #336 review). origin/main treated a failed ruleset
// read as an empty source, so both of these passed there.
const UNKNOWN_RULESET_WITH_OTHER_NAMES = {
  "a failed ruleset page": { requiredPages: [{ message: "unexpected" }, SECOND_PAGE_RULE] },
  "an unlisted rule type": {
    required: [{ type: "deletion" }, { type: "required_checks_v2" }],
  },
};

for (const [shape, override] of Object.entries(UNKNOWN_RULESET_WITH_OTHER_NAMES)) {
  // Usefulness: verifies ${shape} refuses even though classic protection and
  // `gh pr checks --required` both named a required check, so a ruleset-required
  // check the gate never read cannot be skipped (issue #336 review).
  test(`refuses ${shape} even when another source names a required check`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          // Both other sources name a required check, and both checks pass, so
          // only the unknown ruleset read stands between this finish and a pass.
          protection: { required_status_checks: { contexts: ["legacy"] } },
          prChecks: [{ name: "ci (ubuntu-latest)" }],
          headStatuses: [
            { context: "legacy", state: "success", updated_at: "2026-01-01T00:00:00Z" },
          ],
          headRuns: [run("ci (ubuntu-latest)", "success")],
          ...override,
        }),
      ),
    });
    expect(result.ok, `${shape} must refuse whatever the union holds`).toBe(false);
    expect(result.reason).toContain("repository rulesets");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// The paginated bodies the gate cannot account for every page of. Each is unknown
// rather than classified from the pages that arrived (issue #336 review).
const PARTIAL_PAGE_READS = {
  "a body that is not the array of pages": { requiredPages: { rules: [] } },
  "a page that is not an array": { requiredPages: [{ type: "deletion" }, { oops: true }] },
  "a nested page that is not an array": { requiredPages: [[{ type: "deletion" }], null] },
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

// The malformed rule types the classifier used to skip. A type it does not know may
// be a required-status-check rule under a name it has not seen, so each is unknown
// (issue #336 review).
const MALFORMED_RULE_TYPES = {
  "a rule with no type": { parameters: { required_status_checks: [{ context: "ci" }] } },
  "a rule whose type is not a string": { type: 7 },
  "a rule whose type is a known name in the wrong case": { type: "Required_Status_Checks" },
  "a rule whose type GitHub does not document": { type: "required_checks_v2" },
  "a rule whose type is empty": { type: "" },
};

for (const [shape, rule] of Object.entries(MALFORMED_RULE_TYPES)) {
  // Usefulness: verifies a ruleset entry that is ${shape} settles nothing, so a
  // rule the gate cannot read cannot be skipped past as if it required nothing
  // (issue #336 review).
  test(`refuses the empty union and names the source on ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: [{ type: "deletion" }, rule],
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

// Usefulness: verifies every documented rule type other than
// `required_status_checks` still yields the absence, so the known-type list did not
// close the relaxed path on a real ruleset-only branch (issue #336 review).
test("accepts every documented rule type that requires no check", async () => {
  const documented = [
    "branch_name_pattern",
    "code_coverage",
    "code_quality",
    "code_scanning",
    "commit_author_email_pattern",
    "commit_message_pattern",
    "committer_email_pattern",
    "copilot_code_review",
    "creation",
    "deletion",
    "file_extension_restriction",
    "file_path_restriction",
    "license_compliance_scanning",
    "max_file_path_length",
    "max_file_size",
    "merge_queue",
    "non_fast_forward",
    "pull_request",
    "required_deployments",
    "required_linear_history",
    "required_signatures",
    "tag_name_pattern",
    "update",
    "workflows",
  ];
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: documented.map((type) => ({ type })),
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });
});

// A successful empty ruleset read contributes no contexts and leaves the per-check
// path to the other sources, which is what origin/main did for every unreadable
// ruleset reply. A classic-only repository must keep finishing (issue #336 review).
const CLASSIC_ONLY_REPOSITORIES = {
  "classic required contexts that passed": {
    protection: { required_status_checks: { contexts: ["ci (ubuntu-latest)"] } },
    headRuns: [run("ci (ubuntu-latest)", "success")],
  },
  "`gh pr checks --required` names that passed": {
    protection: "hidden",
    prChecks: [{ name: "ci (ubuntu-latest)" }],
    headRuns: [run("ci (ubuntu-latest)", "success")],
  },
};

for (const [shape, override] of Object.entries(CLASSIC_ONLY_REPOSITORIES)) {
  // Usefulness: verifies an empty ruleset read beside ${shape} still finishes, so
  // the strict unknown-ruleset refusal did not refuse a repository that needs no
  // ruleset to say what it requires (issue #336 review).
  test(`finishes on a classic-only repository with ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(routes({ required: [], ...override })),
    });
    expect(result.ok, `an empty ruleset read must not refuse ${shape}`).toBe(true);
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Usefulness: verifies an empty ruleset read is still not a positive absence, so a
// repository whose other source states no required check keeps the empty-union
// refusal, which is the accepted limit for a branch with no ruleset (issue #336
// review).
test("an empty ruleset read is not a positive absence", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(routes({ required: [], protection: null, prChecks: "" })),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("no required checks were found");
  expect(result.reason).toContain("repository rulesets");
  expect(result.noRequiredChecks).toBeUndefined();
});

// The malformed successful replies that must keep the empty-union refusal. The
// allowlist admits one ruleset shape, an array of well-formed rules with no
// required-status-check rule, so each of these is one step away from it and none
// of them states the outcome. A read-only probe that returned one of these as
// `noRequiredChecks: true` is the defect this list covers (issue #336 review).
const MALFORMED_RULESET_READS = {
  "a JSON value that is not an array": { required: { rules: [] } },
  "an entry that is not an object": { required: ["required_status_checks"] },
  "a null entry": { required: [null] },
  "an entry with no type field": { required: [{ parameters: {} }] },
  "an entry whose type is not a string": { required: [{ type: 7 }] },
  "a required-status-check rule that names no check": {
    required: [{ type: "required_status_checks", parameters: { required_status_checks: [] } }],
  },
  "a required-status-check rule whose check list is missing": {
    required: [{ type: "required_status_checks", parameters: {} }],
  },
  "a required-status-check entry with no context": {
    required: [{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }],
  },
  "an empty body": { required: "" },
  "a body that is not JSON": { required: "not json" },
};

for (const [shape, { required }] of Object.entries(MALFORMED_RULESET_READS)) {
  // Usefulness: verifies a ruleset read that is ${shape} settles nothing, so it
  // keeps the empty-union refusal and names the source rather than passing the
  // relaxed path on a reply the gate could not read (issue #336 review).
  test(`refuses the empty union and names the source on a ruleset read that is ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required,
          protection: null,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok, "a malformed ruleset read must not reach the absence path").toBe(false);
    expect(result.reason).toContain("repository rulesets");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// The classic-protection successful replies that must also keep the refusal. Only
// the exact `Branch not protected` 404 proves an absence for that source, so a
// body the gate can read but that states no unprotected branch settles nothing
// (issue #336 review).
const MALFORMED_PROTECTION_READS = {
  "a body that is not the object that endpoint returns": { protection: [] },
  "a body with no required_status_checks field": { protection: { enabled: true } },
  "a required_status_checks field of the wrong type": {
    protection: { required_status_checks: "ci" },
  },
  "a required_status_checks field that names no check": {
    protection: { required_status_checks: {} },
  },
  "a context entry that is not a string": {
    protection: { required_status_checks: { contexts: [7] } },
  },
  "an empty body": { protection: "" },
};

for (const [shape, override] of Object.entries(MALFORMED_PROTECTION_READS)) {
  // Usefulness: verifies a classic-protection read that is ${shape} settles
  // nothing, so it keeps the empty-union refusal and names the source rather than
  // passing the relaxed path on a body that never stated the branch is
  // unprotected (issue #336 review).
  test(`refuses the empty union and names the source on a protection read that is ${shape}`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: [],
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
          ...override,
        }),
      ),
    });
    expect(result.ok, "a protection read that names no unprotected branch must not pass").toBe(
      false,
    );
    expect(result.reason).toContain("no required checks were found");
    expect(result.reason).toContain("classic branch protection");
    expect(result.noRequiredChecks).toBeUndefined();
  });
}

// Usefulness: verifies the absence path is reachable at all, through the one reply
// per source that states the outcome: a ruleset read whose entries are all
// well-formed and none a required-status-check rule, and the exact
// `Branch not protected` 404. Without this the allowlist could pass every test by
// refusing everything (issue #336 review).
test("passes and records the absence when both sources stated the outcome", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "pull_request", parameters: { required_approving_review_count: 0 } },
        ],
        protection: null,
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD, noRequiredChecks: true });
});

// A merge state the gate cannot read must refuse on the absence path exactly as
// it does on the per-check path, so the relaxed path cannot pass on a state the
// gate never understood (issue #336 review). `missing` removes the field, which a
// merge-state override alone cannot express.
const UNREADABLE_MERGE_STATES = {
  "a missing merge state": null,
  "a null merge state": { mergeStateStatus: null },
  "an empty merge state": { mergeStateStatus: "" },
  "an unrecognized merge state": { mergeStateStatus: "MOSTLY_FINE" },
};

/** The `pr view` body for a merge state the gate cannot read. */
function unreadableMergeState(overrides) {
  const info = prInfo(overrides ?? {});
  if (overrides === null) {
    delete info.mergeStateStatus;
  }
  return info;
}

for (const [shape, overrides] of Object.entries(UNREADABLE_MERGE_STATES)) {
  // Usefulness: verifies ${shape} refuses on the relaxed path, so a base branch
  // with no required check is not passed on a merge state the gate could not read
  // (issue #336 review).
  test(`refuses ${shape} on the absence path`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          info: unreadableMergeState(overrides),
          required: [],
          protection: null,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok, "an unreadable merge state must not pass the absence path").toBe(false);
    expect(result.reason).toContain("merge state");
    expect(result.noRequiredChecks).toBeUndefined();
  });

  // Usefulness: verifies ${shape} refuses on the per-check path as well, so the
  // two paths apply one merge-state condition rather than two (issue #336 review).
  test(`refuses ${shape} on the per-check path`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          info: unreadableMergeState(overrides),
          headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
        }),
      ),
    });
    expect(result.ok, "an unreadable merge state must not pass the per-check path").toBe(false);
    expect(result.reason).toContain("merge state");
  });
}

// Usefulness: verifies a `gh pr checks --required` reply that carries no JSON
// contributes no names, so a repository whose every required check never
// reported refuses on the empty union instead of passing vacuously. Live, `gh`
// writes `no required checks reported on the '<branch>' branch` to stderr and
// nothing to stdout, and exits non-zero. The gate reads only stdout, so the exit
// status is not modeled here (issue #280).
test("ignores a gh pr checks --required reply that carries no JSON", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(routes({ required: [], protection: "hidden", prChecks: "" })),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("no required checks were found");
  expect(result.reason).toContain("classic branch protection");
});

// Usefulness: verifies the gate takes required names from `gh pr checks
// --required` when the rules and classic protection sources are empty, so a
// caller without admin rights still gates on the required checks (issue #218).
test("falls back to gh pr checks --required for required names", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [],
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies the gate refuses a blocked merge state, so on a
// classic-protection-only repo a caller without admin rights cannot pass while
// a required check that never reported is absent from every readable source
// (issue #271).
test("refuses a blocked merge state when a required check never reported", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("blocked");
});

// Usefulness: verifies an app-qualified required context is matched to that app,
// is not satisfied by a same-named check run from another app, and keeps its
// qualified judgment when `gh pr checks --required` supplies the bare name
// (issue #271).
test("matches an app-qualified ruleset context to that app", async () => {
  const appRequired = [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "ci", integration_id: 15368 }],
      },
    },
  ];

  const wrongApp = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: appRequired,
        prChecks: [{ name: "ci" }],
        headRuns: [{ ...run("ci", "success"), app: { id: 999 } }],
      }),
    ),
  });
  expect(wrongApp.ok).toBe(false);
  expect(wrongApp.reason).toContain("app 15368");

  const rightApp = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: appRequired,
        prChecks: [{ name: "ci" }],
        headRuns: [
          { ...run("ci", "failure"), app: { id: 999 }, started_at: "2026-01-02T00:00:00Z" },
          { ...run("ci", "success"), app: { id: 15368 }, started_at: "2026-01-01T00:00:00Z" },
        ],
      }),
    ),
  });
  expect(rightApp).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies a 403 from the protection endpoint leaves the source
// unreadable rather than failing the run, because a `GITHUB_TOKEN` without the
// admin scope receives `Resource not accessible by integration` where a caller
// without admin rights receives a 404. Both must reach the blocked refusal, not
// a crash (issue #280).
test("treats a 403 from classic protection as an unreadable source", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        protection: "forbidden",
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("blocked");
});

// Usefulness: verifies the same 403 with no other readable source refuses on the
// empty union, so a `GITHUB_TOKEN` caller on a classic-protection-only repository
// whose required checks never reported still fails closed (issue #280).
test("refuses on the empty union when classic protection answers 403", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        protection: "forbidden",
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("no required checks were found");
  expect(result.reason).toContain("classic branch protection");
});

// Usefulness: verifies the 404 a token without repository admin receives leaves
// the source unreadable rather than failing the run. This is the most common
// non-admin caller, and it is the reply a human token gets on a protected branch,
// confirmed live against cli/cli trunk (#280).
test("treats a non-admin 404 from classic protection as an unreadable source", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        protection: "hidden",
        prChecks: [{ name: "build (ubuntu-latest)" }],
        headRuns: [run("build (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("blocked");
});

// Usefulness: verifies the same non-admin 404 does not stop a caller whose
// required checks all passed from passing. Before the message match, this threw
// instead, so the gate was unusable for a non-admin caller on a repository with
// classic protection (issue #280).
test("passes for a non-admin caller when every required check passed", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [],
        protection: "hidden",
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies a 403 that is not the unreadable-source answer is not
// swallowed. A rate-limit or SSO 403 on the same status would otherwise count as
// "no required contexts" and downgrade a named check refusal to the generic
// blocked refusal, so the gate throws on it instead (issue #280).
test("does not read a rate-limit 403 from classic protection as no contexts", async () => {
  await expect(
    checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: [],
          protection: "rate limited",
          prChecks: [{ name: "ci (ubuntu-latest)" }],
          headRuns: [run("ci (ubuntu-latest)", "failure")],
        }),
      ),
    }),
  ).rejects.toThrow(/HTTP 403/);
});

// Usefulness: verifies a 403 from a fine-grained PAT without the Administration
// permission leaves the source unreadable rather than failing the run, so the
// caller reaches a named refusal. Before the message match, this threw even
// though the PAT has repository read access (issue #295).
test("treats a fine-grained PAT 403 from classic protection as an unreadable source", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        protection: "pat forbidden",
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("blocked");
});

// Usefulness: verifies the same PAT 403 refuses on the empty union when no other
// readable source names a required check, so a fine-grained PAT caller on a
// classic-protection-only repository still fails closed (issue #295).
test("refuses on the empty union when classic protection answers a PAT 403", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        protection: "pat forbidden",
        prChecks: "",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("no required checks were found");
  expect(result.reason).toContain("classic branch protection");
});

// Usefulness: verifies a fine-grained PAT caller passes when every required
// check passed and the protection source is unreadable. This is the case the
// missing message broke: a read-capable PAT could never finish (issue #295).
test("passes for a fine-grained PAT caller when every required check passed", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [],
        protection: "pat forbidden",
        prChecks: [{ name: "ci (ubuntu-latest)" }],
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies the exact Free-plan 403 leaves both API sources settling
// nothing rather than failing the run, so a private Free-plan repository reaches
// the named empty-union refusal and not the relaxed path. The reply names the
// plan, not the branch, and it is written the same way for a branch that exists
// and one that does not, so it cannot establish that no required check exists
// (#301, #336 review).
test("refuses and names both sources when the required-context sources answer the Free-plan 403", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: `stderr: ${FREE_PLAN}`,
        protection: `stderr: ${FREE_PLAN}`,
        prChecks: "rate limited",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  // The ruleset source settles nothing, so the gate refuses on it first and never
  // reaches the classic-protection source. Both are unknown; only the one that
  // refuses is named, which is the source a fix must target first.
  expect(result.reason).toContain("repository rulesets");
});

for (const [ending, suffix] of Object.entries(ENDINGS)) {
  // Usefulness: verifies the exact Free-plan 403 is read as a source that settles
  // nothing with ${ending}, the one trailing line break `gh` may add included, so
  // a caller on a private Free-plan repository keeps the empty-union refusal
  // whatever that trailing break is (issue #301, #336 review).
  test(`reads the exact Free-plan 403 with ${ending} as an unknown source`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          required: [],
          protection: `stderr: ${FREE_PLAN}${suffix}`,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no required checks were found");
    expect(result.reason).toContain("classic branch protection");
  });
}

// Reply shapes that carry the Free-plan message but are not the whole reply
// `gh` writes. Each must throw, because reading one as an unreadable source
// would drop every required context and downgrade a named check refusal
// (issue #301).
const NOT_THE_WHOLE_REPLY = {
  "text before the message": `gh: failed to fetch: ${FREE_PLAN}`,
  "text after the status": `${FREE_PLAN}: retry later`,
  "another line beside it": `${FREE_PLAN}\ngh: failed to fetch: no such host`,
  "two trailing line breaks": `${FREE_PLAN}\n\n`,
};

for (const [shape, reply] of Object.entries(NOT_THE_WHOLE_REPLY)) {
  // Usefulness: verifies a Free-plan 403 carrying ${shape} throws instead of
  // silently emptying the source (issue #301).
  test(`throws on a Free-plan 403 carrying ${shape}`, async () => {
    await expect(
      checkCi({
        pr: 42,
        reviewed: REVIEWED,
        cwd: ".",
        gh: fakeGh(
          routes({
            required: [],
            protection: `stderr: ${reply}`,
            prChecks: [{ name: "ci (ubuntu-latest)" }],
            headRuns: [run("ci (ubuntu-latest)", "failure")],
          }),
        ),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
}

// Usefulness: verifies an app-qualified context from classic branch protection
// is matched by its app_id, not by name alone (issue #271).
test("matches an app-qualified classic-protection context to that app", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [],
        protection: {
          required_status_checks: { contexts: [], checks: [{ context: "ci", app_id: 15368 }] },
        },
        headRuns: [{ ...run("ci", "success"), app: { id: 999 } }],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("app 15368");
});

// Usefulness: verifies the `-1` any-app qualifier is treated as no qualifier, so
// a check run from any app satisfies it (issue #271).
test("treats a -1 app qualifier as unqualified", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        required: [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci", integration_id: -1 }] },
          },
        ],
        headRuns: [{ ...run("ci", "success"), app: { id: 999 } }],
      }),
    ),
  });
  expect(result).toEqual({ ok: true, commit: HEAD });
});

// Usefulness: verifies a blocked merge state does not hide the name of a failing
// required check, so a refusal still names the failed condition (issue #271).
test("names the failing check when the merge state is also blocked", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        headRuns: [run("ci (ubuntu-latest)", "failure"), run("ci (windows-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("ci (ubuntu-latest)");
  expect(result.reason).toContain("failure");
});

// Usefulness: verifies the gate refuses a conflicted PR (merge state DIRTY)
// before the per-check pass, so a conflicted PR cannot pass even when its
// discovered checks pass (issue #271).
test("refuses a PR with merge conflicts", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "DIRTY" }),
        headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
      }),
    ),
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("conflicts");
});

// Usefulness: verifies the gate refuses when the PR head differs from the
// reviewed commit (issue #218).
test("refuses when the PR head differs from the reviewed commit", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: { ...REVIEWED, head: "3333333333333333333333333333333333333333" },
    cwd: ".",
    gh: fakeGh(routes()),
  });
  expect(result).toEqual({ ok: false, reason: "the PR head differs from the reviewed commit" });
});

// Usefulness: verifies the gate refuses a reviewed work tree that is not clean
// (issue #218).
test("refuses a reviewed work tree that is not clean", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: { ...REVIEWED, clean: false },
    cwd: ".",
    gh: fakeGh(routes()),
  });
  expect(result).toEqual({ ok: false, reason: "the reviewed work tree is not clean" });
});

// Usefulness: verifies the gate refuses when the reviewer turn carries no
// reviewed state (issue #218).
test("refuses when there is no reviewed state", async () => {
  const result = await checkCi({ pr: 42, reviewed: null, cwd: ".", gh: fakeGh(routes()) });
  expect(result).toEqual({
    ok: false,
    reason: "the latest reviewer turn has no reviewed state",
  });
});

// A status-read stub: it answers the PR head the read resolves first, then the
// required-check list. `checks` is the list body, `status` the exit code `gh`
// reports with it, and `head` the PR head the stub claims, so a test can place
// the read on a head that matches or does not match the local one.
function statusReadGh({ checks = [], status = 0, head = HEAD, stderr = "" } = {}) {
  return async (args) => {
    const key = args.join(" ");
    if (key === "pr view 42 --json headRefOid") {
      return { status: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" };
    }
    if (key === "pr checks 42 --required --json name,bucket") {
      return { status, stdout: JSON.stringify(checks), stderr };
    }
    return { status: 1, stdout: "", stderr: `unmatched gh call: ${key}` };
  };
}

// The read resolves the PR head before the check list, so every status test
// states the local head it compares against.
const readOn = (head, gh) => readRequiredChecks({ pr: 42, cwd: ".", head, gh });

// Usefulness: verifies the read reports a pass from a reply that lists the
// required checks, so a reviewer prompt carries the status and the evidence
// behind it rather than a bare word (issue #320).
test("reads a passing status with the names of the listed required checks", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      checks: [
        { name: "ci (ubuntu-latest)", bucket: "pass" },
        { name: "ci (windows-latest)", bucket: "skipping" },
      ],
    }),
  );
  expect(read).toMatchObject({
    pr: 42,
    status: "pass",
    checks: ["ci (ubuntu-latest)", "ci (windows-latest)"],
  });
});

// Usefulness: verifies the read names the failing check, so a reviewer that
// cannot reach the network still sees which required check failed on the PR
// head (issue #320).
test("reads a failing status with the name of the failing required check", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      // Exit 1 is how `gh` reports a failing check, alongside a pass and a
      // pending one in the same list.
      status: 1,
      checks: [
        { name: "ci (macos-latest)", bucket: "fail" },
        { name: "ci (ubuntu-latest)", bucket: "pass" },
      ],
    }),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (macos-latest)"] });
  expect(read.summary).toContain("ci (macos-latest)");
});

// Usefulness: verifies a pending check reads as pending and not as a failure,
// because a pending check is not a blocker (issue #320).
test("reads a pending status with the name of the pending required check", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      status: 8,
      checks: [
        { name: "ci (ubuntu-latest)", bucket: "pass" },
        { name: "ci (windows-latest)", bucket: "pending" },
      ],
    }),
  );
  expect(read).toMatchObject({ status: "pending", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies a failing check outranks a pending one, because a
// failing check is the blocker a reviewer must see first (issue #320).
test("reads a failing status when a pending check sits beside a failing one", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      status: 1,
      checks: [
        { name: "ci (macos-latest)", bucket: "fail" },
        { name: "ci (windows-latest)", bucket: "pending" },
      ],
    }),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (macos-latest)"] });
});

// Usefulness: verifies a reply that lists no check reads as unresolved, so an
// empty required set never reaches a reviewer prompt as a pass (issue #320).
test("reads an unresolved status when the reply lists no required check", async () => {
  const read = await readOn(HEAD, statusReadGh({ checks: [] }));
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
});

// Usefulness: verifies a non-zero reply with no JSON reads as unresolved, so a
// read error or a repository with no required check never reads as a pass
// (issue #320).
test("reads an unresolved status when gh cannot list the required checks", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    gh: statusReadGhRaw({ status: 1, stdout: "", stderr: "no required checks" }),
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
  expect(read.summary).toContain("no required checks");
});

// A stub that answers the check list with a raw body, for a reply that is not
// the JSON the read asks for.
function statusReadGhRaw({ status, stdout, stderr }) {
  return async (args) => {
    const key = args.join(" ");
    if (key === "pr view 42 --json headRefOid") {
      return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD }), stderr: "" };
    }
    if (key === "pr checks 42 --required --json name,bucket") {
      return { status, stdout, stderr };
    }
    return { status: 1, stdout: "", stderr: `unmatched gh call: ${key}` };
  };
}

// Usefulness: verifies a gh failure that throws reads as unresolved instead of
// failing the reviewer turn, because the read is supplied evidence and the
// reviewer keeps its own read (issue #320).
test("reads an unresolved status when the gh runner fails", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    gh: async (args) => {
      const key = args.join(" ");
      if (key === "pr view 42 --json headRefOid") {
        return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD }), stderr: "" };
      }
      throw new Error("spawn gh ENOENT");
    },
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
  expect(read.summary).toContain("spawn gh ENOENT");
});

// Usefulness: verifies the read never reports a pass for a PR head that differs
// from the local head the reviewer sees, because a status read on one head says
// nothing about the other, and the supplied status must state the head it
// describes (issue #320 review).
test("never reports a pass when the PR head differs from the local reviewed head", async () => {
  const local = "2222222222222222222222222222222222222222";
  const read = await readOn(
    local,
    statusReadGh({ checks: [{ name: "ci (ubuntu-latest)", bucket: "pass" }] }),
  );
  expect(read.status).toBe("unresolved");
  expect(read.summary).toContain(HEAD);
  expect(read.summary).toContain(local);
});

// Usefulness: verifies a matching head still reports its status, so the head
// comparison refuses only a mismatch and not every read (issue #320 review).
test("reports the status for a read whose PR head matches the local reviewed head", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({ checks: [{ name: "ci (ubuntu-latest)", bucket: "pass" }] }),
  );
  expect(read).toMatchObject({ status: "pass", head: HEAD });
  expect(read.summary).toContain(HEAD);
});

// Usefulness: verifies every supplied status states the head it describes, so a
// reviewer and a parent can tell which commit the status covers (issue #320
// review).
test("states the PR head in the summary of every status", async () => {
  for (const [bucket, exit, status] of [
    ["pass", 0, "pass"],
    ["fail", 1, "failing"],
    ["pending", 8, "pending"],
  ]) {
    const read = await readOn(
      HEAD,
      statusReadGh({ checks: [{ name: "ci", bucket }], status: exit }),
    );
    expect(read.status, bucket).toBe(status);
    expect(read.summary, bucket).toContain(HEAD);
  }
});

// Usefulness: verifies a read with no local head to compare against never reports
// a pass, because the runtime cannot show the status belongs to the reviewed
// commit (issue #320 review).
test("reads an unresolved status when no local head is available to compare", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: null,
    gh: statusReadGh({ checks: [{ name: "ci (ubuntu-latest)", bucket: "pass" }] }),
  });
  expect(read.status).toBe("unresolved");
});

// Usefulness: verifies malformed output reads as unresolved rather than as a
// pass, because a lenient parse drops the malformed entries and keeps the
// passing ones, so a reply that is not wholly well-formed must not report a
// status (issue #320 review).
test("reads an unresolved status when the reply mixes a pass entry with malformed entries", async () => {
  for (const stdout of [
    '[{"name":"ci","bucket":"pass"},"junk"]',
    '[{"name":"ci","bucket":"pass"},null]',
    '[{"name":"ci","bucket":"pass"},{"name":7,"bucket":"pass"}]',
    '[{"name":"ci","bucket":"pass"},{"name":"x","bucket":true}]',
  ]) {
    const read = await readOn(HEAD, statusReadGhRaw({ status: 0, stdout, stderr: "" }));
    expect(read.status, stdout).toBe("unresolved");
  }
});

// Usefulness: verifies every status is read from the exit code the documented
// contract names, so a reply that carries a different exit code never reports a
// status the exit code contradicts (issue #320 review).
test("reads the status the documented exit code names, and unresolved otherwise", async () => {
  const listed = JSON.stringify([{ name: "ci", bucket: "pass" }]);
  for (const [status, expected] of [
    [0, "pass"],
    [8, "pending"],
    [1, "unresolved"],
    [2, "unresolved"],
    [null, "unresolved"],
    [undefined, "unresolved"],
  ]) {
    const read = await readOn(HEAD, statusReadGhRaw({ status, stdout: listed, stderr: "" }));
    expect(read.status, `exit ${status}`).toBe(expected);
  }
});

// Usefulness: verifies exit code 1 with a listed failing check reports failing,
// because that combination is how `gh` reports a failing check, and the read must
// not lose the name the finish gate would refuse on (issue #320 review).
test("reads a failing status from exit code 1 with a listed failing check", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({ status: 1, checks: [{ name: "ci (macos-latest)", bucket: "fail" }] }),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (macos-latest)"] });
});

// Usefulness: verifies a read that exceeds its time bound yields unresolved
// rather than stalling the dispatch, and the hung child is terminated so it
// cannot outlive the read (issue #320 review).
test("reads an unresolved status when the gh call exceeds the time bound", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    timeoutMs: 25,
    gh: (args, _cwd, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("read timed out")));
      }),
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
  expect(read.summary).toMatch(/timed out|abort/i);
});

// Usefulness: verifies the real `gh` runner answers a status read through the
// same options the read passes, including the abort signal. The unit stubs
// accept any option shape, so only the real runner catches an option name that
// the installed execa rejects, which is what made every real read fail
// (issue #320 review).
test("the real gh runner runs a bounded read and terminates a hung child", async () => {
  const { runGh } = await import("../../src/lib/ci-gate.mjs");
  const controller = new AbortController();
  const reply = await runGh(["--version"], ".", {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  expect(reply.status).toBe(0);
  expect(reply.stdout.trim()).toMatch(/^gh version/);

  // A hung child is terminated by the bound, which is what keeps a stalled
  // `gh` from outliving the read.
  const hung = await runGh(["pr", "checks", "42", "--json", "name,bucket"], ".", {
    signal: AbortSignal.timeout(1),
    timeoutMs: 1,
  });
  expect(hung.status).not.toBe(0);
});

// Usefulness: verifies a read whose PR head moves between the head read and the
// check read reports nothing, because the checks that came back describe the new
// head while the first head read named the old one, so a status bound to the
// first read would describe a commit the reviewer is not looking at
// (issue #320 review, second round).
test("reads no status when the PR head moves between the head read and the check read", async () => {
  const local = "1111111111111111111111111111111111111111";
  const advanced = "2222222222222222222222222222222222222222";
  let headReads = 0;

  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: local,
    gh: async (args) => {
      const key = args.join(" ");
      if (key === "pr view 42 --json headRefOid") {
        headReads += 1;
        // The first read matches the local head; the PR advances before the
        // checks are read, so the second read names a different commit.
        return {
          status: 0,
          stdout: JSON.stringify({ headRefOid: headReads === 1 ? local : advanced }),
          stderr: "",
        };
      }
      if (key === "pr checks 42 --required --json name,bucket") {
        return {
          status: 0,
          stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]),
          stderr: "",
        };
      }
      return { status: 1, stdout: "", stderr: `unmatched gh call: ${key}` };
    },
  });

  // A stable head is re-read, so the race is detectable at all.
  expect(headReads).toBeGreaterThan(1);
  expect(read.status).toBe("unresolved");
  expect(read.checks).toEqual([]);
  expect(read.summary).toMatch(/(moved|changed|differs)/i);
});

// Usefulness: verifies a head that advances to a commit which then matches the
// local reviewed head is still unresolved, because the checks were read for a
// different commit than the one the status would name
// (issue #320 review, second round).
test("reads no status when the head moves even to a head the checks then describe", async () => {
  const local = "1111111111111111111111111111111111111111";
  const advanced = "2222222222222222222222222222222222222222";
  let headReads = 0;

  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: local,
    gh: async (args) => {
      const key = args.join(" ");
      if (key === "pr view 42 --json headRefOid") {
        headReads += 1;
        return {
          status: 0,
          stdout: JSON.stringify({ headRefOid: headReads === 1 ? local : advanced }),
          stderr: "",
        };
      }
      return { status: 0, stdout: JSON.stringify([{ name: "ci", bucket: "pass" }]), stderr: "" };
    },
  });

  expect(read.status).toBe("unresolved");
});

// Usefulness: verifies a head that does not move still reports its status, so
// the re-read refuses only a real race and not every read
// (issue #320 review, second round).
test("still reports the status when the PR head does not move", async () => {
  const read = await readOn(HEAD, statusReadGh({ checks: [{ name: "ci", bucket: "pass" }] }));
  expect(read).toMatchObject({ status: "pass", head: HEAD });
});

// Usefulness: verifies every supplied status is marked advisory, because the head
// and the checks are separate calls: a head that advances to another commit and
// returns between them leaves both head reads naming the same commit while the
// checks describe the other one, and no number of re-reads separates that case.
// `gh pr checks` reports no commit, and reading check runs for the exact commit
// would replace the required-name source with three ruleset and protection reads.
// The status is therefore advisory evidence the reviewer and the `--require-ci`
// gate settle, never a status a consumer can read as verified
// (issue #320 review, third round).
test("every supplied status is marked advisory", async () => {
  for (const [checks, status] of [
    [[{ name: "ci", bucket: "pass" }], "pass"],
    [[{ name: "ci", bucket: "fail" }], "failing"],
    [[{ name: "ci", bucket: "pending" }], "pending"],
  ]) {
    const exit = status === "failing" ? 1 : status === "pending" ? 8 : 0;
    const read = await readOn(HEAD, statusReadGh({ checks, status: exit }));
    expect(read.status, status).toBe(status);
    // Marked advisory, so no consumer can read it as a verified status, and the
    // marker survives a read that reached the checks through the window above.
    expect(read.advisory, status).toBe(true);
  }
});

// Usefulness: verifies the status is advisory in the one case the head re-read
// cannot catch, so the mark is not a decoration that only well-behaved reads
// carry (issue #320 review, third round).
test("a status read through the A-to-B-to-A window is still marked advisory", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    gh: async (args) => {
      const key = args.join(" ");
      if (key === "pr view 42 --json headRefOid") {
        return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD }), stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ name: "ci-on-B", bucket: "pass" }]),
        stderr: "",
      };
    },
  });
  // The checks belong to a commit the head reads cannot name, so the read may
  // report a status; what it must never do is report one as verified.
  expect(read.advisory).toBe(true);
});

// A real `gh` on PATH that hangs, so the bound is exercised against a real child
// process. The shim writes a marker file after a delay that outlasts the bound:
// a marker means the child outlived the bound, and no marker means the bound
// terminated it. The shim is a `.cmd` on Windows and an executable shell script
// on macOS, which is what `gh` resolves to on each platform.
async function hangingGh(dir, marker, afterMs) {
  const path = marker.split("\\").join("/");
  if (process.platform === "win32") {
    await writeFile(
      join(dir, "gh.cmd"),
      `@echo off\r\nnode -e "setTimeout(function(){require('fs').writeFileSync('${path}','x')},${afterMs})"\r\n`,
    );
    return;
  }
  await writeFile(join(dir, "gh"), `#!/bin/sh\nsleep ${afterMs / 1000}\ntouch '${marker}'\n`, {
    mode: 0o755,
  });
}

// Usefulness: verifies the `gh` runner terminates the child when its bound
// expires, on Windows and on macOS. A real process is the only way to check that
// the kill reaches the child, because an injected runner never spawns one
// (issue #329).
test("runGh terminates the gh child when its bound expires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gh-timeout-"));
  const marker = join(dir, "alive.txt");
  await hangingGh(dir, marker, 2000);
  const path = process.env.PATH;

  try {
    process.env.PATH = `${dir}${delimiter}${path}`;
    const started = Date.now();
    const result = await runGh(["pr", "checks", "42", "--required"], dir, { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    // The child was terminated, not abandoned: it never reaches its marker.
    await delay(2500);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    process.env.PATH = path;
    await removePath(dir);
  }
}, 15000);
