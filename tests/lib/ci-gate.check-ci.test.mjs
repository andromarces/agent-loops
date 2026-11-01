import { expect, test } from "vite-plus/test";
import { checkCi } from "../../src/lib/ci-gate.mjs";
import {
  barrierGh,
  commitStatus,
  fakeGh,
  HEAD,
  HEAD_CHECK_RUNS,
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
  run,
  stallingGh,
} from "./ci-gate-helpers.mjs";

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

// Usefulness: verifies the --require-ci gate still refuses a finish on a transport failure.
// The failure carries `transient` for the wait only, so the gate retries nothing (issue #1312).
test("refuses a finish when a commit read fails with a transport failure", async () => {
  const failing = routes().map(([match, value]) =>
    match === HEAD_CHECK_RUNS
      ? [
          match,
          'stderr: Get "https://api.github.com/repos/x/commits/y": dial tcp 20.205.243.168:443: connect: operation timed out',
        ]
      : [match, value],
  );
  await expect(
    checkCi({ pr: 42, reviewed: REVIEWED, cwd: ".", gh: fakeGh(failing) }),
  ).rejects.toThrow(/dial tcp .*connect: operation timed out/);
});
