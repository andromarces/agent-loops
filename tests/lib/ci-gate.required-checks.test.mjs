import {} from "node:path";
import { expect, test } from "vite-plus/test";
import { checkCi, readRequiredChecks } from "../../src/lib/ci-gate.mjs";
import { equalsArgs } from "../runtime-helpers.mjs";
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
  PR_CHECKS,
  PR_VIEW,
  prInfo,
  REPO_VIEW,
  REVIEWED,
  routes,
  run,
  stallingGh,
  withStatusPages,
} from "./ci-gate-helpers.mjs";

// A status-read stub over the gate's own fixtures: the read resolves the PR head,
// the required contexts, and the check runs and statuses of the reviewed commit.
// `head` is the PR head the stub claims, so a test can place the read on a head
// that matches or does not match the local one.
function statusReadGh({ head = HEAD, ...rest } = {}) {
  return fakeGh(routes({ info: prInfo({ headRefOid: head }), ...rest }));
}

const BOTH_PASS = [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")];

// The read states the local head it compares against.
const readOn = (head, gh, clean = true) =>
  readRequiredChecks({ pr: 42, cwd: ".", head, clean, gh });

// Usefulness: verifies the read reports a pass from the check runs of the
// required contexts, so a reviewer prompt carries the status and the evidence
// behind it rather than a bare word (issue #320).
test("reads a passing status with the names of the required checks", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "skipped")],
    }),
  );
  expect(read).toMatchObject({
    pr: 42,
    status: "pass",
    checks: ["ci (ubuntu-latest)", "ci (windows-latest)"],
  });
});

// Usefulness: verifies the read judges a required check by its commit status as
// well as by a check run, because the gate accepts both and the read must not
// disagree with it (issue #349).
test("reads a passing status when a required check is a commit status", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "success")],
      headStatuses: [commitStatus("ci (windows-latest)", "success")],
    }),
  );
  expect(read).toMatchObject({ status: "pass" });
});

// Usefulness: verifies the read names the failing check, so a reviewer that
// cannot reach the network still sees which required check failed on the PR
// head (issue #320).
test("reads a failing status with the name of the failing required check", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "failure")],
    }),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
  expect(read.summary).toContain("ci (windows-latest)");
});

// Usefulness: verifies a pending check reads as pending and not as a failure,
// because a pending check is not a blocker (issue #320).
test("reads a pending status with the name of the pending required check", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "success"), openRun("ci (windows-latest)")],
    }),
  );
  expect(read).toMatchObject({ status: "pending", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies a required check that has not reported reads as pending
// with its name, never as a pass, because the gate refuses a missing check
// (issue #349).
test("reads a pending status for a required check that has not reported", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({ headRuns: [run("ci (ubuntu-latest)", "success")] }),
  );
  expect(read).toMatchObject({ status: "pending", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies a failing check outranks a pending one, because a
// failing check is the blocker a reviewer must see first (issue #320).
test("reads a failing status when a pending check sits beside a failing one", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "failure"), openRun("ci (windows-latest)", "queued")],
    }),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (ubuntu-latest)"] });
});

// Usefulness: verifies a base branch with no required check reads as unresolved,
// so an empty required set never reaches a reviewer prompt as a pass (issue #320).
test("reads an unresolved status when no required check exists", async () => {
  const read = await readOn(HEAD, statusReadGh({ required: [], headRuns: BOTH_PASS }));
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
});

// Usefulness: verifies a ruleset read that settles nothing reads as unresolved,
// because that reply may hide a required check the read never judged, the same
// refusal the gate makes (issue #349).
test("reads an unresolved status when the repository rulesets cannot be read", async () => {
  const read = await readOn(
    HEAD,
    fakeGh(
      routes({ headRuns: BOTH_PASS }).map(([m, v]) =>
        m.includes("/rules/") ? [m, "hidden"] : [m, v],
      ),
    ),
  );
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
  expect(read.summary).toContain("rulesets");
});

// Usefulness: verifies a gh failure that throws reads as unresolved instead of
// failing the reviewer turn, because the read is supplied evidence and the
// reviewer keeps its own read (issue #320).
test("reads an unresolved status when the gh runner fails", async () => {
  const read = await readOn(HEAD, async (args) => {
    if (equalsArgs(args, PR_VIEW.split(" "))) {
      return { status: 0, stdout: JSON.stringify(prInfo()), stderr: "" };
    }
    throw new Error(`spawn gh ENOENT: ${JSON.stringify(args)}`);
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
  // The failure names the call after the PR view, so a PR-view route that stops
  // matching moves the failure to the first call and fails this test.
  expect(read.summary).toContain(`spawn gh ENOENT: ${JSON.stringify(REPO_VIEW.split(" "))}`);
});

// Usefulness: verifies the read never reports a pass for a PR head that differs
// from the local head the reviewer sees, because a status read on one head says
// nothing about the other, and the supplied status must state the head it
// describes (issue #320 review).
test("never reports a pass when the PR head differs from the local reviewed head", async () => {
  const local = "2222222222222222222222222222222222222222";
  const read = await readOn(local, statusReadGh({ headRuns: BOTH_PASS }));
  expect(read.status).toBe("unresolved");
  expect(read.summary).toContain(HEAD);
  expect(read.summary).toContain(local);
});

// Usefulness: verifies a matching head still reports its status, so the head
// comparison refuses only a mismatch and not every read (issue #320 review).
test("reports the status for a read whose PR head matches the local reviewed head", async () => {
  const read = await readOn(HEAD, statusReadGh({ headRuns: BOTH_PASS }));
  expect(read).toMatchObject({ status: "pass", head: HEAD });
  expect(read.summary).toContain(HEAD);
});

// Usefulness: verifies every supplied status states the head it describes, so a
// reviewer and a parent can tell which commit the status covers (issue #320
// review).
test("states the reviewed head in the summary of every status", async () => {
  for (const [headRuns, status] of [
    [BOTH_PASS, "pass"],
    [[run("ci (ubuntu-latest)", "failure"), run("ci (windows-latest)", "success")], "failing"],
    [[run("ci (ubuntu-latest)", "success")], "pending"],
  ]) {
    const read = await readOn(HEAD, statusReadGh({ headRuns }));
    expect(read.status, status).toBe(status);
    expect(read.summary, status).toContain(HEAD);
  }
});

// Usefulness: verifies a read with no local head to compare against never reports
// a pass, because the runtime cannot show the status belongs to the reviewed
// commit (issue #320 review).
test("reads an unresolved status when no local head is available to compare", async () => {
  const read = await readOn(null, statusReadGh({ headRuns: BOTH_PASS }));
  expect(read.status).toBe("unresolved");
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

// Usefulness: verifies a `gh` rejection whose `message` getter throws still yields an
// unresolved status. A getter that throws inside the catch block would replace the
// read result with a throw and fail the dispatch (issue #475).
test("reads an unresolved status when the error message getter throws", async () => {
  const hostile = new Error("hidden");
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("message getter");
    },
  });
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    gh: async () => {
      throw hostile;
    },
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
});

// Usefulness: verifies a `gh` rejection whose `message` is an object with its own
// `toString` key still yields an unresolved status. The serialized message has no
// callable `toString`, so a plain string conversion of it throws inside the catch
// block (issue #475 review).
test("reads an unresolved status when the error message is a non-string with a toString key", async () => {
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    gh: async () => {
      throw Object.assign(new Error("hidden"), { message: { toString: 1 } });
    },
  });
  expect(read).toMatchObject({ status: "unresolved", checks: [] });
});

// Usefulness: verifies the status describes the reviewed commit A when the PR
// head moves from A to B and back to A during the read. The stub models the race
// itself: every head read returns A, while the `gh pr checks` list, the only
// read that took no commit, describes B and fails. The old read reported that
// failure for A. The new read takes the check runs of A by SHA, so it reports A's
// pass and never asks for B (issue #349).
test("binds the status to the reviewed commit when the PR head moves A to B to A", async () => {
  const other = "3333333333333333333333333333333333333333";
  const calls = [];
  const served = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    if (equalsArgs(args, PR_CHECKS.split(" "))) {
      served.push(args);
      return {
        status: 1,
        stdout: JSON.stringify([{ name: "ci (ubuntu-latest)", bucket: "fail" }]),
        stderr: "",
      };
    }
    if (args[0] === "api" && args[1]?.includes(`commits/${other}/`)) {
      return {
        status: 1,
        stdout: "",
        stderr: `the read asked for commit B: ${JSON.stringify(args)}`,
      };
    }
    return statusReadGh({ headRuns: BOTH_PASS })(args);
  };
  const read = await readOn(HEAD, gh);
  expect(read).toMatchObject({ status: "pass", head: HEAD });
  expect(calls.filter((call) => call.includes(other))).toEqual([]);
  // The stale list is the fixture this test names, so a route that stops matching
  // fails here instead of passing on a fallback list.
  expect(served).toEqual([PR_CHECKS.split(" ")]);
});

// Usefulness: verifies a reply the read cannot parse is unresolved and never a
// pass, because a lenient parse would read a missing check-run list, a missing
// status list, or an unreadable context source as no objection (issue #349).
test.each([
  ["a null check-runs reply", "check-runs", "null"],
  ["a check-runs page with no list", "check-runs", {}],
  [
    "a check run with no name",
    "check-runs",
    { check_runs: [{ status: "completed", conclusion: "success" }] },
  ],
  [
    "a completed check run with no conclusion",
    "check-runs",
    { check_runs: [{ name: "ci (ubuntu-latest)", status: "completed" }] },
  ],
  [
    "a check run with an unknown status",
    "check-runs",
    { check_runs: [{ name: "ci (ubuntu-latest)", status: "weird" }] },
  ],
  ["a null status reply", "/status?", "null"],
  ["a status page with no list", "/status?", {}],
  [
    "a status with an unknown state",
    "/status?",
    { statuses: [{ context: "ci (ubuntu-latest)", state: "weird" }] },
  ],
  ["a status with no context", "/status?", { statuses: [{ state: "success" }] }],
  ["a ruleset reply that is not JSON", "rules/branches", "not json"],
  ["an empty ruleset reply", "rules/branches", ""],
  ["a protection reply that is not JSON", "branches/main/protection", "<html>"],
])("reads an unresolved status for %s", async (_name, endpoint, body) => {
  const gh = fakeGh(
    routes({ headRuns: BOTH_PASS }).map(([match, value]) =>
      match.includes(endpoint) ? [match, body] : [match, value],
    ),
  );
  const read = await readOn(HEAD, gh);
  expect(read.status).toBe("unresolved");
  expect(read.checks).toEqual([]);
});

// Usefulness: verifies the read follows every page of the commit status reply, as
// the check-run read does, so a failing required status on a later page is not
// missed (issue #349).
test("reads a failing status from a later page of the commit status reply", async () => {
  const gh = fakeGh(
    withStatusPages(routes({ headRuns: [run("ci (ubuntu-latest)", "success")] }), [
      [commitStatus("unrelated", "success")],
      [commitStatus("ci (windows-latest)", "failure")],
    ]),
  );
  const read = await readOn(HEAD, gh);
  expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies a pending commit status reads as pending, not failing,
// because it has not failed, while the gate keeps its refusal (issue #349).
test("reads a pending status for a pending commit status", async () => {
  const read = await readOn(
    HEAD,
    statusReadGh({
      headRuns: [run("ci (ubuntu-latest)", "success")],
      headStatuses: [commitStatus("ci (windows-latest)", "pending")],
    }),
  );
  expect(read).toMatchObject({ status: "pending", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies an entry the read cannot order, and a classic protection
// reply it cannot interpret, read as unresolved and never as a pass, because the
// latest entry per name decides and a pass could outrank a newer failure, and an
// uninterpreted protection reply may hide a required check (issue #349).
test.each([
  [
    "a check run with no id",
    "check-runs",
    {
      check_runs: [
        {
          name: "ci (ubuntu-latest)",
          status: "completed",
          conclusion: "success",
          started_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ],
  [
    "a check run with a start time that is not a date",
    "check-runs",
    { check_runs: [{ ...run("ci (ubuntu-latest)", "success"), started_at: "zzz" }] },
  ],
  [
    "a commit status with no update time",
    "/status?",
    { statuses: [{ id: 1, context: "ci (ubuntu-latest)", state: "success" }] },
  ],
  [
    "a commit status with an update time that is not a date",
    "/status?",
    { statuses: [{ ...commitStatus("ci (ubuntu-latest)", "success"), updated_at: "later" }] },
  ],
  ["a protection reply that is an array", "branches/main/protection", []],
  [
    "a protection reply with a required-check list that is not an object",
    "branches/main/protection",
    { required_status_checks: "ci" },
  ],
  [
    "a protection reply with contexts that are not a list",
    "branches/main/protection",
    { required_status_checks: { contexts: "ci" } },
  ],
  [
    "a protection reply with a check that names no context",
    "branches/main/protection",
    { required_status_checks: { checks: [{}] } },
  ],
])("reads an unresolved status for %s", async (_name, endpoint, body) => {
  const gh = fakeGh(
    routes({ headRuns: BOTH_PASS }).map(([match, value]) =>
      match.includes(endpoint) ? [match, body] : [match, value],
    ),
  );
  const read = await readOn(HEAD, gh);
  expect(read.status).toBe("unresolved");
  expect(read.checks).toEqual([]);
});

// Usefulness: verifies a protection reply with no required-check list is
// interpretable, so the uninterpretable-shape refusal does not reject a branch
// that is protected without a required check (issue #349).
test("reads a status when classic protection names no required check", async () => {
  const gh = fakeGh(
    routes({ headRuns: BOTH_PASS }).map(([match, value]) =>
      match.includes("branches/main/protection")
        ? [match, { required_pull_request_reviews: {} }]
        : [match, value],
    ),
  );
  expect((await readOn(HEAD, gh)).status).toBe("pass");
});

// Usefulness: verifies a failed read of the required names reads as unresolved,
// because the list may name a required check that no configuration source did,
// while the `no required checks` answer still reads (issue #349).
test.each([
  ["a failed call", "stderr: gh: HTTP 502", "unresolved"],
  ["a reply that is not JSON", "not json", "unresolved"],
  ["a list with an entry that names nothing", [{}], "unresolved"],
  [
    "the no required checks answer",
    "stderr: no required checks reported on the 'main' branch",
    "pass",
  ],
])("reads the required names from %s", async (_name, reply, expected) => {
  const gh = fakeGh(
    routes({ headRuns: BOTH_PASS }).map(([match, value]) =>
      match === PR_CHECKS ? [match, reply] : [match, value],
    ),
  );
  expect((await readOn(HEAD, gh)).status).toBe(expected);
});

// Usefulness: verifies the supplied status never passes a state the finish gate
// refuses, because the read and the gate judge the same pages and the same
// evaluated commit: a success on page two decides for both, and a failing test
// merge commit refuses both (issue #349).
test.each([
  [
    "a later success on page two of the commit statuses",
    {
      headRuns: [run("ci (ubuntu-latest)", "success")],
      statusPages: [
        [commitStatus("ci (windows-latest)", "failure", "2026-01-01T00:00:00Z")],
        [commitStatus("ci (windows-latest)", "success", "2026-01-02T00:00:00Z")],
      ],
    },
  ],
  [
    "a failing check run on the test merge commit",
    { headRuns: BOTH_PASS, mergeRuns: [run("ci (ubuntu-latest)", "failure")] },
  ],
  [
    "a passing test merge commit over a failing head",
    { headRuns: [run("ci (ubuntu-latest)", "failure")], mergeRuns: BOTH_PASS },
  ],
  ["a failing required check on the head", { headRuns: [run("ci (ubuntu-latest)", "failure")] }],
  ["passing checks on a work tree that is not clean", { headRuns: BOTH_PASS, clean: false }],
  ...[
    "CLEAN",
    "UNSTABLE",
    "HAS_HOOKS",
    "DRAFT",
    "BLOCKED",
    "BEHIND",
    "DIRTY",
    "UNKNOWN",
    "SOMETHING_NEW",
    "",
    null,
    undefined,
  ].map((mergeStateStatus) => [
    `passing checks with merge state ${JSON.stringify(mergeStateStatus) ?? "missing"}`,
    { headRuns: BOTH_PASS, info: prInfo({ mergeStateStatus }) },
  ]),
])(
  "the supplied status agrees with the finish gate on %s",
  async (_name, { statusPages, clean = true, ...options }) => {
    const table = statusPages ? withStatusPages(routes(options), statusPages) : routes(options);
    const read = await readOn(HEAD, fakeGh(table), clean);
    const gate = await checkCi({
      pr: 42,
      reviewed: { ...REVIEWED, clean },
      cwd: ".",
      gh: fakeGh(table),
    });
    expect(read.status === "pass").toBe(gate.ok);
    // Only a served second page passes: the head run covers one required check
    // and the later success covers the other, so an unserved fixture refuses both.
    if (statusPages) {
      expect(gate.ok).toBe(true);
    }
  },
);

// Usefulness: verifies an empty check-run name or an empty status context reads as
// unresolved and never as a pass, because an entry that names nothing cannot be
// matched to a required check and must not be skipped (issue #349).
test.each([
  ["an empty check-run name", "check-runs", { check_runs: [...BOTH_PASS, run("", "success")] }],
  ["an empty status context", "/status?", { statuses: [commitStatus("", "success")] }],
])("reads an unresolved status for %s", async (_name, endpoint, body) => {
  const gh = fakeGh(
    routes({ headRuns: BOTH_PASS }).map(([match, value]) =>
      match.includes(endpoint) ? [match, body] : [match, value],
    ),
  );
  expect((await readOn(HEAD, gh)).status).toBe("unresolved");
});

// Usefulness: verifies a required-name read that did not succeed reads as
// unresolved whatever its stdout holds, while the documented exit 1 and exit 8
// answers that carry a list still read (issue #349).
const NAMES = '[{"name":"ci (ubuntu-latest)"}]';

const NO_CHECKS = "no required checks reported on the 'main' branch";

test.each([
  ["exit 2 with a JSON list", { status: 2, stdout: NAMES, stderr: "" }, "unresolved"],
  ["exit 1 with an empty JSON list", { status: 1, stdout: "[]", stderr: "" }, "unresolved"],
  ["exit 4 with the no-checks text", { status: 4, stdout: "", stderr: NO_CHECKS }, "unresolved"],
  [
    "exit 1 with an error that quotes the no-checks text",
    { status: 1, stdout: "", stderr: `gh: HTTP 502: ${NO_CHECKS} (retry)` },
    "unresolved",
  ],
  ["exit 1 with a list", { status: 1, stdout: NAMES, stderr: "" }, "pass"],
  ["exit 8 with a list", { status: 8, stdout: NAMES, stderr: "" }, "pass"],
  [
    "exit 1 with the exact no-checks answer",
    { status: 1, stdout: "", stderr: `${NO_CHECKS}\n` },
    "pass",
  ],
])("reads the required names from %s", async (_name, reply, expected) => {
  const table = fakeGh(routes({ headRuns: BOTH_PASS }));
  const gh = async (args, ...rest) =>
    equalsArgs(args, PR_CHECKS.split(" ")) ? reply : table(args, ...rest);
  expect((await readOn(HEAD, gh)).status).toBe(expected);
});

// Usefulness: verifies a merge state the finish gate refuses withholds the pass, so
// the status never reports a pass for a state the gate refuses, while a failing
// check keeps its own word (issue #349).
test.each(["BLOCKED", "BEHIND", "DIRTY", "UNKNOWN", "SOMETHING_NEW"])(
  "reads a non-pass status for merge state %s",
  async (mergeStateStatus) => {
    const info = prInfo({ mergeStateStatus });
    const read = await readOn(HEAD, statusReadGh({ headRuns: BOTH_PASS, info }));
    expect(read.status).toBe("unresolved");
    expect(read.summary).toContain(HEAD);
    const failing = await readOn(
      HEAD,
      statusReadGh({
        headRuns: [run("ci (ubuntu-latest)", "failure"), run("ci (windows-latest)", "success")],
        info,
      }),
    );
    expect(failing.status).toBe("failing");
  },
);

// Usefulness: verifies a failure wins over pending when entries share a required
// name, so a rerun, another run, or a commit status that has not finished cannot
// mask a failure beside it (issue #349).
test.each([
  [
    "a check run and a commit status",
    {
      headRuns: [run("ci (ubuntu-latest)", "success"), openRun("ci (windows-latest)")],
      headStatuses: [commitStatus("ci (windows-latest)", "failure")],
    },
  ],
  [
    "several check runs",
    {
      headRuns: [
        run("ci (ubuntu-latest)", "success"),
        { ...run("ci (windows-latest)", "failure"), started_at: "2026-01-01T00:00:00Z" },
        { ...openRun("ci (windows-latest)"), started_at: "2026-01-02T00:00:00Z" },
      ],
    },
  ],
  [
    "several commit statuses",
    {
      headRuns: [run("ci (ubuntu-latest)", "success")],
      headStatuses: [
        commitStatus("ci (windows-latest)", "error", "2026-01-01T00:00:00Z"),
        commitStatus("ci (windows-latest)", "pending", "2026-01-02T00:00:00Z"),
      ],
    },
  ],
])("reads a failing status over a pending one for %s", async (_name, options) => {
  const read = await readOn(HEAD, statusReadGh(options));
  expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies the latest entry at equal timestamps is the one with the
// larger numeric id, so run `10` outranks run `9` and a failing latest entry is
// not read as a pass (issue #737).
test.each([
  [
    "check runs",
    {
      headRuns: [
        run("ci (ubuntu-latest)", "success"),
        { ...run("ci (windows-latest)", "success"), id: 9 },
        { ...run("ci (windows-latest)", "failure"), id: 10 },
      ],
    },
  ],
  [
    "commit statuses",
    {
      headRuns: [run("ci (ubuntu-latest)", "success")],
      headStatuses: [
        { ...commitStatus("ci (windows-latest)", "success"), id: 9 },
        { ...commitStatus("ci (windows-latest)", "failure"), id: 10 },
      ],
    },
  ],
])(
  "reads the entry with the larger numeric id at equal timestamps for %s",
  async (_name, options) => {
    const read = await readOn(HEAD, statusReadGh(options));
    expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
  },
);

// Usefulness: verifies entries order by parsed time, so a newer failure with
// fractional seconds or a non-UTC offset is not hidden behind an older pass whose
// text sorts higher (issue #737 review).
test.each(
  ["check runs", "commit statuses"].flatMap((kind) => [
    [kind, "fractional seconds", "2026-01-01T00:00:00.500Z", "2026-01-01T00:00:00Z"],
    [kind, "a non-UTC offset", "2026-01-01T01:00:00Z", "2026-01-01T05:00:00+05:00"],
  ]),
)("reads the newer failing entry for %s with %s", async (kind, _name, failAt, passAt) => {
  const field = kind === "check runs" ? "started_at" : "updated_at";
  const read = await readOn(
    HEAD,
    statusReadGh(pairOptions(kind, { id: 10, [field]: failAt }, { id: 11, [field]: passAt })),
  );
  expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
});

// Usefulness: verifies timestamps order below the millisecond and across offsets,
// so a newer failure that differs from an older pass only in the last fractional
// digits is not hidden (issue #737 review).
test.each(
  ["check runs", "commit statuses"].flatMap((kind) => [
    [kind, "UTC", "2026-01-01T00:00:00.1235Z", "2026-01-01T00:00:00.1234Z"],
    [kind, "an offset", "2026-01-01T05:00:00.0000002+05:00", "2026-01-01T00:00:00.0000001Z"],
  ]),
)(
  "reads the newer failing %s that differs below the millisecond in %s",
  async (kind, _name, failAt, passAt) => {
    const field = kind === "check runs" ? "started_at" : "updated_at";
    const read = await readOn(
      HEAD,
      statusReadGh(pairOptions(kind, { id: 10, [field]: failAt }, { id: 11, [field]: passAt })),
    );
    expect(read).toMatchObject({ status: "failing", checks: ["ci (windows-latest)"] });
  },
);

// Usefulness: verifies every supplied status stays advisory after the commit
// binding, because the read is a pre-turn snapshot and the `--require-ci` gate
// re-reads GitHub and enforces the condition (issue #349).
test("every supplied status is marked advisory", async () => {
  for (const [headRuns, status] of [
    [BOTH_PASS, "pass"],
    [[run("ci (ubuntu-latest)", "failure"), run("ci (windows-latest)", "success")], "failing"],
    [[run("ci (ubuntu-latest)", "success")], "pending"],
  ]) {
    const read = await readOn(HEAD, statusReadGh({ headRuns }));
    expect(read.status, status).toBe(status);
    expect(read.advisory, status).toBe(true);
  }
});

// Usefulness: verifies the status read also starts its independent reads together
// (issue #731), a second entry point that shares the same read functions.
test("starts the independent gh reads of the status read together", async () => {
  const gh = barrierGh(
    fakeGh(
      routes({
        mergeRuns: [run("ci (ubuntu-latest)", "success"), run("ci (windows-latest)", "success")],
      }),
    ),
    INDEPENDENT_GROUPS,
  );
  const read = await readRequiredChecks({ pr: 42, cwd: ".", head: HEAD, clean: true, gh });
  expect(read.status).toBe("pass");
});

// Usefulness: verifies the status read reports the earlier read's error, not a
// timeout, when a later sibling stalls (issue #731 review). Waiting for the stall
// would run out the bound and mask the failure.
test("the status read reports the earlier read error, not a timeout, when a sibling stalls", async () => {
  const failing = routes().map(([match, value]) =>
    match === MERGE_CHECK_RUNS ? [match, "stderr: runs down"] : [match, value],
  );
  const { gh } = stallingGh(fakeGh(failing), [MERGE_STATUS]);
  const started = Date.now();
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    clean: true,
    timeoutMs: 5000,
    gh,
  });
  expect(read.status).toBe("unresolved");
  expect(read.summary).toMatch(/runs down/);
  expect(read.summary).not.toMatch(/timed out/);
  expect(Date.now() - started).toBeLessThan(2500);
});

// Usefulness: verifies the same for the status read, whose head mismatch returns
// before the repository read settles (issue #731 review).
test("an early unresolved status read leaves no gh call running", async () => {
  const { gh, live } = stallingGh(fakeGh(routes({ info: prInfo({ headRefOid: MERGE }) })), [
    REPO_VIEW,
  ]);
  const read = await readRequiredChecks({ pr: 42, cwd: ".", head: HEAD, clean: true, gh });
  expect(read.status).toBe("unresolved");
  expect(live.active).toBe(0);
});

// Usefulness: verifies a failure decided before the deadline stays the outcome when
// the deadline expires while the aborted sibling is still ending (issue #731
// review). A slow-terminating child must not turn the first failure into a timeout.
test("the status read keeps an earlier failure when the deadline expires during sibling cleanup", async () => {
  const failing = routes().map(([match, value]) =>
    match === MERGE_CHECK_RUNS ? [match, "stderr: runs down"] : [match, value],
  );
  const { gh, live } = stallingGh(fakeGh(failing), [MERGE_STATUS], 500);
  const read = await readRequiredChecks({
    pr: 42,
    cwd: ".",
    head: HEAD,
    clean: true,
    timeoutMs: 250,
    gh,
  });
  expect(read.status).toBe("unresolved");
  expect(read.summary).toMatch(/runs down/);
  expect(read.summary).not.toMatch(/timed out/);
  expect(live.active).toBe(0);
});
