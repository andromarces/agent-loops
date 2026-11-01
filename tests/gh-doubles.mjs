import assert from "node:assert/strict";
import { ok } from "./agent-doubles.mjs";

/**
 * True when `args` begins with the elements of `lead`, compared element by
 * element. A call that merges arguments into one element does not match, which
 * a substring test on the joined text cannot tell apart.
 */
export function startsWithArgs(args, lead) {
  return lead.every((part, i) => args[i] === part);
}

/** True when `args` equals `expected` element by element, with no extra element. */
export function equalsArgs(args, expected) {
  return args.length === expected.length && startsWithArgs(args, expected);
}

/** The exact argument elements of the request for one page of a paged `gh api` read of `endpoint`. */
export const pagedApiArgs = (endpoint, page = 1) => [
  "api",
  `${endpoint}?per_page=100&page=${page}`,
  "--include",
];

/** The stdout of one `gh api --include` request that answered 200 with `body`, as JSON unless it is text. */
export const pageStdout = (body) =>
  `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;

/** The exact argument elements of the gate's `gh pr view` read. */
export const prViewArgs = (pr) => [
  "pr",
  "view",
  String(pr),
  "--json",
  "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit,state",
];

/** The exact argument elements of the gate's `gh pr checks` read. */
export const prChecksArgs = (pr) => ["pr", "checks", String(pr), "--required", "--json", "name"];

/** The exact argument elements of the gate's `gh repo view` read. */
export const REPO_VIEW_ARGS = ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"];

/** The exact argument elements of a `gh api` read of `endpoint` with `flags`. */
export const apiArgs = (endpoint, flags = []) => ["api", endpoint, ...flags];

/** True when `args` request page `page` of the paged read of the endpoint that ends with `suffix`. */
export function isPagedRead(args, suffix, page = 1) {
  return (
    args[0] === "api" &&
    typeof args[1] === "string" &&
    args[1].endsWith(`${suffix}?per_page=100&page=${page}`) &&
    equalsArgs(args.slice(2), ["--include"])
  );
}

/** Every `gh` read the gate makes for PR 42 on `owner/repo` at `head`, as exact arguments. */
export const gateReadCalls = (head) => [
  prViewArgs(42),
  REPO_VIEW_ARGS,
  pagedApiArgs("repos/owner/repo/rules/branches/main"),
  apiArgs("repos/owner/repo/branches/main/protection"),
  pagedApiArgs(`repos/owner/repo/commits/${head}/check-runs`),
  pagedApiArgs(`repos/owner/repo/commits/${head}/status`),
  prChecksArgs(42),
];

/**
 * Asserts that `gh` fails every malformed variant of each call in `calls`: the
 * last two elements merged into one, the last element dropped, and an extra
 * element added. Each failure prints the arguments as an array.
 */
export async function expectNoReplyToMalformedCalls(gh, calls) {
  for (const args of calls) {
    const variants = [
      [...args.slice(0, -2), args.slice(-2).join(" ")],
      args.slice(0, -1),
      [...args, "--extra"],
    ];
    for (const bad of variants) {
      const reply = await gh(bad);
      assert.equal(reply.status, 1, `a reply to ${JSON.stringify(bad)}`);
      assert.equal(reply.stdout, "");
      assert.ok(reply.stderr.includes(JSON.stringify(bad)), `no array in: ${reply.stderr}`);
    }
  }
}

/** The finish summary the gate tests send. */
export const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };

/** A reviewer reply whose verdict accepts the reviewed state. */
export const REVIEW_ACCEPT = [
  "Conclusion: the state passes.",
  "Why: changes match the task.",
  "Blockers: none.",
  "Checks: npm test",
  "Verdict: accept",
].join("\n");

/** A reviewer reply whose verdict rejects the reviewed state. */
export const REVIEW_REJECT = [
  "Conclusion: the state fails.",
  "Why: the change is incomplete.",
  "Blockers: none.",
  "Verdict: reject",
].join("\n");

/** Role state for a run whose orchestrator, worker, and reviewer use the `orch`, `work`, and `rev` adapters. */
export function gateRoles() {
  return {
    orchestrator: { kind: "orch", sessionId: null },
    worker: { kind: "work", sessionId: null },
    reviewer: { kind: "rev", sessionId: null },
  };
}

/** The check run that `prGateGh` reports by default: a passing required check. */
export const PASSING_RUN = {
  id: 1,
  name: "ci (ubuntu-latest)",
  status: "completed",
  conclusion: "success",
  started_at: "2026-01-01T00:00:00Z",
};

/**
 * A `gh` double for the gate's reads of PR 42 on `owner/repo`. It replies only to the exact
 * argument elements of each read and fails any other call with the arguments printed as an array.
 * `headRefOid` is the PR head the gate compares with the reviewed commit. `calls` receives each
 * call as joined text. `runs` are the check runs every commit carries, and `required` is the
 * context the base-branch ruleset requires.
 */
export function prGateGh(
  headRefOid,
  calls = [],
  runs = [PASSING_RUN],
  required = "ci (ubuntu-latest)",
) {
  return async (args) => {
    calls.push(args.join(" "));
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (equalsArgs(args, prViewArgs(42))) {
      return json({
        headRefOid,
        baseRefName: "main",
        mergeStateStatus: "CLEAN",
        potentialMergeCommit: null,
        state: "OPEN",
      });
    }
    if (equalsArgs(args, REPO_VIEW_ARGS)) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (equalsArgs(args, prChecksArgs(42))) {
      return json([]);
    }
    if (equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main"))) {
      // The ruleset read pages by number, so each reply is one page: a list of rules.
      return ok(
        pageStdout([
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: required }] },
          },
        ]),
      );
    }
    if (equalsArgs(args, apiArgs("repos/owner/repo/branches/main/protection"))) {
      return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (isPagedRead(args, "/check-runs")) {
      return ok(pageStdout({ total_count: runs.length, check_runs: runs }));
    }
    if (isPagedRead(args, "/status")) {
      return ok(pageStdout({ total_count: 0, statuses: [] }));
    }
    return { status: 1, stdout: "", stderr: `unmatched: ${JSON.stringify(args)}` };
  };
}

/**
 * The `gh` state of a private repository on the GitHub Free plan (#301): the ruleset and classic
 * protection reads answer the exact plan 403, so the gate cannot read any required-check source.
 * `calls` receives each call as joined text.
 */
export function freePlanGh(headRefOid, calls = []) {
  const read = prGateGh(headRefOid, calls);
  const refusal = {
    status: 1,
    stdout: "",
    stderr:
      "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
  };
  return async (args, cwd, options) => {
    if (
      equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main")) ||
      equalsArgs(args, apiArgs("repos/owner/repo/branches/main/protection"))
    ) {
      calls.push(args.join(" "));
      return refusal;
    }
    return read(args, cwd, options);
  };
}

/**
 * The `gh` state of a base branch whose required-check sources cannot be read for a reason other
 * than the plan, a network failure: every call fails with a transport error.
 */
export function unreachableGh(calls = []) {
  return async (args) => {
    calls.push(args.join(" "));
    return { status: 1, stdout: "", stderr: "gh: dial tcp: lookup api.github.com: no such host" };
  };
}

/**
 * The `gh` state of a ruleset-only base branch with no required check: the ruleset read returns
 * well-formed rules with no required-status-check rule, classic protection answers the exact 404,
 * and the required-names read carries no list. `calls` receives those two reads as joined text.
 */
export function noRequiredCheckGh(headRefOid, calls = []) {
  const read = prGateGh(headRefOid);
  return async (args) => {
    if (equalsArgs(args, pagedApiArgs("repos/owner/repo/rules/branches/main"))) {
      calls.push(args.join(" "));
      return ok(
        pageStdout([
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "pull_request", parameters: { required_approving_review_count: 0 } },
        ]),
      );
    }
    if (equalsArgs(args, prChecksArgs(42))) {
      calls.push(args.join(" "));
      return { status: 1, stdout: "", stderr: "no required checks reported" };
    }
    return read(args);
  };
}
