import { expect, test } from "vitest";
import { checkCi, readRequiredChecks } from "../../src/lib/ci-gate.mjs";

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
  protection = null,
  prChecks = [],
} = {}) {
  return [
    ["pr view 42", info],
    ["pr checks 42", prChecks],
    ["repo view", "andromarces/agent-loops"],
    ["rules/branches/main", required],
    ["branches/main/protection", protection],
    [`commits/${MERGE}/check-runs`, [{ check_runs: mergeRuns }]],
    [`commits/${MERGE}/status`, { statuses: mergeStatuses }],
    [`commits/${HEAD}/check-runs`, [{ check_runs: headRuns }]],
    [`commits/${HEAD}/status`, { statuses: headStatuses }],
  ];
}

const REVIEWED = { head: HEAD, clean: true, exact: true, digest: "d" };

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

// Usefulness: verifies the gate refuses when every required-check source is
// empty even though a check failed and the merge state is blocked, so an
// unreadable protection endpoint can never pass vacuously (issue #218).
test("refuses when no required checks are found", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: [],
        headRuns: [run("ci (ubuntu-latest)", "failure")],
      }),
    ),
  });
  expect(result).toEqual({
    ok: false,
    reason: "no required checks were found for the base branch",
  });
});

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
    gh: fakeGh(routes({ required: [], prChecks: "", headRuns: [run("reported-pass", "success")] })),
  });
  expect(result).toEqual({
    ok: false,
    reason: "no required checks were found for the base branch",
  });
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
  expect(result).toEqual({
    ok: false,
    reason: "no required checks were found for the base branch",
  });
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
  expect(result).toEqual({
    ok: false,
    reason: "no required checks were found for the base branch",
  });
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

// Usefulness: verifies the exact Free-plan 403 leaves the API sources unreadable
// rather than failing the run, so an admin on a private Free-plan repository
// reaches the named empty-union refusal instead of a raw throw. The plan does
// not allow the rule that would require a check, so the source holds no required
// contexts. `gh pr checks --required` is a separate source whose reply is not
// measured; the fixture fails it so the union is empty the way an unmeasured
// failure would leave it (issue #301).
test("refuses on the empty union when the required-context sources answer the Free-plan 403", async () => {
  const result = await checkCi({
    pr: 42,
    reviewed: REVIEWED,
    cwd: ".",
    gh: fakeGh(
      routes({
        info: prInfo({ mergeStateStatus: "BLOCKED" }),
        required: `stderr: ${FREE_PLAN}`,
        protection: `stderr: ${FREE_PLAN}`,
        prChecks: "rate limited",
        headRuns: [run("ci (ubuntu-latest)", "success")],
      }),
    ),
  });
  expect(result).toEqual({
    ok: false,
    reason: "no required checks were found for the base branch",
  });
});

// The exact reply a private repository on the GitHub Free plan writes to the
// required-context API endpoints (#301).
const FREE_PLAN =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

const ENDINGS = { "no line ending": "", LF: "\n", CRLF: "\r\n" };

for (const [ending, suffix] of Object.entries(ENDINGS)) {
  // Usefulness: verifies the exact Free-plan 403 is read as an unreadable source
  // with ${ending}, the one trailing line break `gh` may add included, so a
  // caller on a private Free-plan repository reaches a named refusal (issue #301).
  test(`reads the exact Free-plan 403 with ${ending} as an unreadable source`, async () => {
    const result = await checkCi({
      pr: 42,
      reviewed: REVIEWED,
      cwd: ".",
      gh: fakeGh(
        routes({
          info: prInfo({ mergeStateStatus: "BLOCKED" }),
          required: [],
          protection: `stderr: ${FREE_PLAN}${suffix}`,
          prChecks: "",
          headRuns: [run("ci (ubuntu-latest)", "success")],
        }),
      ),
    });
    expect(result).toEqual({
      ok: false,
      reason: "no required checks were found for the base branch",
    });
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
