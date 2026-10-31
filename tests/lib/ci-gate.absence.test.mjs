import { expect, test } from "vite-plus/test";
import { checkCi } from "../../src/lib/ci-gate.mjs";
import { fakeGh, HEAD, prInfo, REVIEWED, routes, run } from "./ci-gate-helpers.mjs";

// The exact reply a private repository on the GitHub Free plan writes to the
// required-context API endpoints (#301).
const FREE_PLAN =
  "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)";

// The one trailing line break `gh` may add to a reply, and the shapes it may add
// that are not the whole reply.
const ENDINGS = { "no line ending": "", LF: "\n", CRLF: "\r\n" };

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
