import { expect, test } from "vite-plus/test";
import { checkCi } from "../../src/lib/ci-gate.mjs";
import {
  equalsArgs,
  expectNoReplyToMalformedCalls,
  isPagedRead,
  pagedApiArgs,
  pageStdout,
} from "../gh-doubles.mjs";
import {
  barrierGh,
  commitStatus,
  fakeGh,
  HEAD,
  INDEPENDENT_GROUPS,
  MERGE,
  MERGE_CHECK_RUNS,
  MERGE_STATUS,
  openRun,
  pairOptions,
  PR_VIEW,
  prInfo,
  REPO_VIEW,
  REVIEWED,
  routes,
  SLUG,
  run,
  stallingGh,
} from "./ci-gate-helpers.mjs";

// Usefulness: verifies the double routes on the argument elements, so a call
// that merges the arguments into one element gets no reply and its error prints
// the array, which differs from the text of the expected call (issue #530).
test("the gh double gives no reply to a malformed call", async () => {
  const calls = routes().map(([match]) => match.split(" "));
  await expectNoReplyToMalformedCalls(fakeGh(routes()), calls);
});

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

// An unknown ruleset read must refuse whatever the rest of the union holds, because
// that reply may carry a required-status rule this caller never saw, and a
// non-empty union from another source would otherwise let the per-check pass judge
// only the names it saw (issue #336 review). the gate before issue #336 treated a failed ruleset
// read as an empty source, so both of these passed there.
const UNKNOWN_RULESET_WITH_OTHER_NAMES = {
  "a failed ruleset page": { requiredPages: [{ message: "unexpected" }] },
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
// path to the other sources, which is how the gate before issue #336 treated every unreadable
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

// Usefulness: verifies the two local refusals read nothing from GitHub, so a
// change that moves either check after a `gh` call fails here (#366).
test.each([
  ["no reviewed state", null, "the latest reviewer turn has no reviewed state"],
  [
    "a work tree that is not clean",
    { ...REVIEWED, clean: false },
    "the reviewed work tree is not clean",
  ],
])("refuses on %s with no gh call", async (_name, reviewed, reason) => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    return fakeGh(routes())(args);
  };
  const result = await checkCi({ pr: 42, reviewed, cwd: ".", gh });
  expect(result).toEqual({ ok: false, reason });
  expect(calls).toEqual([]);
});

// Usefulness: verifies the finish gate refuses a pending commit status with its
// existing reason, so the read's classification does not change the gate
// (issue #349).
test("refuses a pending required commit status with the unchanged reason", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        headRuns: [run("ci (ubuntu-latest)", "success")],
        headStatuses: [commitStatus("ci (windows-latest)", "pending")],
      }),
    ),
  });
  expect(result).toEqual({
    ok: false,
    reason: 'required check "ci (windows-latest)" failed (commit status pending)',
  });
});

const gateOver = (options) =>
  checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh: fakeGh(routes(options)) });

// Usefulness: verifies entries whose order is unknown fail the gate instead of
// passing, so each kind of invalid id at equal timestamps cannot let a passing
// entry hide a failing one (issue #737 review).
test.each(
  ["check runs", "commit statuses"].flatMap((kind) => [
    [kind, "a missing id", { id: undefined }],
    [kind, "a null id", { id: null }],
    [kind, "a non-numeric string id", { id: "abc" }],
  ]),
)("does not pass %s with equal timestamps and %s", async (kind, _name, passing) => {
  const result = await gateOver(pairOptions(kind, { id: 10 }, passing));
  expect(result.ok).toBe(false);
});

// Usefulness: verifies an unparseable timestamp fails the gate instead of passing,
// so an entry that cannot be ordered cannot hide a failing one (issue #737 review).
test.each(["check runs", "commit statuses"])(
  "does not pass %s with an unparseable timestamp",
  async (kind) => {
    const field = kind === "check runs" ? "started_at" : "updated_at";
    const result = await gateOver(pairOptions(kind, { id: 10 }, { id: 11, [field]: "later" }));
    expect(result.ok).toBe(false);
  },
);

// Usefulness: verifies a group with a missing timestamp never passes, so an entry
// that cannot be ordered cannot hide a failing one (issue #737 review).
test.each(["check runs", "commit statuses"])(
  "does not pass %s when an entry has no timestamp",
  async (kind) => {
    const field = kind === "check runs" ? "started_at" : "updated_at";
    for (const [failing, passing] of [
      [{ id: 10, [field]: undefined }, { id: 11 }],
      [{ id: 10 }, { id: 11, [field]: undefined }],
    ]) {
      const result = await gateOver(pairOptions(kind, failing, passing));
      expect(result.ok).toBe(false);
    }
    const passes = pairOptions(kind, { id: 10 }, { id: 11, [field]: undefined });
    for (const entry of passes.headRuns.concat(passes.headStatuses ?? [])) {
      if (entry.conclusion === "failure") entry.conclusion = "success";
      if (entry.state === "failure") entry.state = "success";
    }
    expect((await gateOver(passes)).ok).toBe(false);
  },
);

// Usefulness: verifies a queued entry with a malformed timestamp keeps the
// pending classification it had before issue #737, so the gate waits instead of failing
// (issue #737 review).
test.each([
  [
    "check run",
    {
      headRuns: [
        run("ci (ubuntu-latest)", "success"),
        run("ci (windows-latest)", "success"),
        { ...openRun("ci (windows-latest)", "queued"), started_at: "later" },
      ],
    },
  ],
  [
    "commit status",
    {
      headRuns: [run("ci (ubuntu-latest)", "success")],
      headStatuses: [
        commitStatus("ci (windows-latest)", "success"),
        { ...commitStatus("ci (windows-latest)", "pending"), updated_at: "later" },
      ],
    },
  ],
])("keeps a queued %s with a malformed timestamp pending", async (_name, options) => {
  const result = await gateOver(options);
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("pending");
});

// Usefulness: verifies only the RFC 3339 shape GitHub returns orders at full
// precision, so a lowercase or space-separated timestamp fails closed instead of
// losing its sub-millisecond digits and hiding a newer failure (issue #737 review).
test.each(
  ["check runs", "commit statuses"].flatMap((kind) => [
    [kind, "a lowercase", "2026-01-01t00:00:00.1235z"],
    [kind, "a space-separated", "2026-01-01 00:00:00.1235Z"],
  ]),
)("does not pass %s with %s timestamp", async (kind, _name, failAt) => {
  const field = kind === "check runs" ? "started_at" : "updated_at";
  const result = await gateOver(
    pairOptions(
      kind,
      { id: 10, [field]: failAt },
      { id: 11, [field]: "2026-01-01T00:00:00.1234Z" },
    ),
  );
  expect(result.ok).toBe(false);
});

// Usefulness: verifies an unordered group of successful runs reports pending
// beside a pending commit status of the same name, so the gate waits, as it did before issue #737, instead of reporting a failure (issue #737 review).
test("reports pending for unordered successful runs beside a pending commit status", async () => {
  const result = await gateOver({
    headRuns: [
      run("ci (ubuntu-latest)", "success"),
      { ...run("ci (windows-latest)", "success"), id: 10 },
      { ...run("ci (windows-latest)", "success"), id: 11, started_at: undefined },
    ],
    headStatuses: [commitStatus("ci (windows-latest)", "pending")],
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("pending");
  expect(result.reason).not.toContain("failing");
});

// Usefulness: verifies the gate starts its independent gh reads together (issue
// #731). A gate that runs them in sequence never starts the second call of a
// group while the first is held, so the double fails the held call.
test("starts the independent gh reads of the gate together", async () => {
  const gh = barrierGh(
    fakeGh(
      routes({
        mergeRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
      }),
    ),
    INDEPENDENT_GROUPS,
  );
  const result = await checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh });
  expect(result).toEqual({ ok: true, commit: MERGE });
});

// Usefulness: verifies that when two parallel reads fail, the error that the
// sequential order surfaced still wins (issue #731): the check-run read, not the
// commit-status read.
test("surfaces the check-run failure when the commit-status read also fails", async () => {
  const failing = routes().map(([match, value]) =>
    match.includes("/check-runs?") || match.includes("/status?")
      ? [match, `stderr: ${match.includes("/status?") ? "status down" : "runs down"}`]
      : [match, value],
  );
  await expect(
    checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh: fakeGh(failing) }),
  ).rejects.toThrow(/check-runs failed: runs down/);
});

// Usefulness: verifies the PR read error wins over a repository read error and
// that a PR refusal still returns when the repository read fails (issue #731),
// as the sequential order did.
test("keeps the PR read ahead of the repository read", async () => {
  const gh = (overrides) => fakeGh([...overrides, ...routes()]);
  await expect(
    checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: gh([
        [PR_VIEW, "stderr: pr down"],
        [REPO_VIEW, "stderr: repo down"],
      ]),
    }),
  ).rejects.toThrow(/gh pr view 42 failed: pr down/);
  const refused = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: gh([
      [PR_VIEW, prInfo({ mergeStateStatus: "BEHIND" })],
      [REPO_VIEW, "stderr: repo down"],
    ]),
  });
  expect(refused.ok).toBe(false);
});

// Usefulness: verifies the earlier read's error throws promptly while a later
// sibling stalls (issue #731 review). Waiting for the stalled sibling would hang
// the gate, which the sequential order never did.
test("surfaces the earlier read error without waiting for a stalled sibling", async () => {
  const failing = routes().map(([match, value]) =>
    match === MERGE_CHECK_RUNS ? [match, "stderr: runs down"] : [match, value],
  );
  const { gh } = stallingGh(fakeGh(failing), [MERGE_STATUS]);
  const started = Date.now();
  await expect(checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh })).rejects.toThrow(
    /check-runs failed: runs down/,
  );
  expect(Date.now() - started).toBeLessThan(1000);
});

// Usefulness: verifies an early refusal leaves no gh call running once the gate
// returns (issue #731 review). The repository read starts beside the PR read, so
// a refusal that returns first must cancel and settle it.
test("an early refusal leaves no gh call running", async () => {
  const { gh, live } = stallingGh(
    fakeGh(routes({ info: prInfo({ mergeStateStatus: "BEHIND" }) })),
    [REPO_VIEW],
  );
  const result = await checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh });
  expect(result.ok).toBe(false);
  expect(live.active).toBe(0);
});

// Usefulness: verifies a failed PR read leaves no repository read running when it
// throws (issue #731 review).
test("a thrown PR read error leaves no gh call running", async () => {
  const { gh, live } = stallingGh(fakeGh([[PR_VIEW, "stderr: pr down"], ...routes()]), [REPO_VIEW]);
  await expect(checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh })).rejects.toThrow(/pr down/);
  expect(live.active).toBe(0);
});
