// Doubles for the check wait: a scripted `gh` and a fake clock, used by the `check-wait` and
// `role wait-checks` tests.
import { equalsArgs, isPagedRead, ok, pageStdout, startsWithArgs } from "../runtime-helpers.mjs";

// True when `args` is exactly the wait's read, `gh pr checks <pr> --required --json
// name,state,bucket`, so a missing, extra, or merged argument does not match. With
// `all`, the read is the same without `--required`.
function isCheckWaitRead(args, all) {
  const tail = all
    ? ["--json", "name,state,bucket"]
    : ["--required", "--json", "name,state,bucket"];
  return (
    args.length === 3 + tail.length &&
    startsWithArgs(args, ["pr", "checks"]) &&
    Number.isInteger(Number(args[2])) &&
    equalsArgs(args.slice(3), tail)
  );
}

/** The PR head a scripted `gh` reports when a test scripts no other. */
export const HEAD_A = "a".repeat(40);
/** A second head, for a test whose PR head moves. */
export const HEAD_B = "b".repeat(40);

// True when `args` is exactly the wait's head read, `gh pr view <pr> --json headRefOid,baseRefName`.
function isHeadRead(args) {
  return (
    args.length === 5 &&
    startsWithArgs(args, ["pr", "view"]) &&
    Number.isInteger(Number(args[2])) &&
    equalsArgs(args.slice(3), ["--json", "headRefOid,baseRefName"])
  );
}

function headReply(head) {
  return {
    status: 0,
    stdout: JSON.stringify({ headRefOid: head, baseRefName: "main" }),
    stderr: "",
    timedOut: false,
  };
}

const RUN_STATUS_OF_STATE = {
  PENDING: "pending",
  QUEUED: "queued",
  IN_PROGRESS: "in_progress",
  WAITING: "waiting",
  REQUESTED: "requested",
};
const CONCLUSION_OF_BUCKET = {
  pass: "success",
  fail: "failure",
  cancel: "cancelled",
  skipping: "skipped",
};

// The check run of the REST check-runs reply that a `{ name, state, bucket }` check item stands for.
function runOfItem({ name, state, bucket, appId, startedAt }, index) {
  const pending = bucket === "pending" || state in RUN_STATUS_OF_STATE;
  return {
    id: index + 1,
    name,
    status: pending ? (RUN_STATUS_OF_STATE[state] ?? "in_progress") : "completed",
    conclusion: pending ? null : (state?.toLowerCase() ?? CONCLUSION_OF_BUCKET[bucket]),
    started_at: startedAt ?? "2026-01-01T00:00:00Z",
    completed_at: pending ? null : (startedAt ?? "2026-01-01T00:01:00Z"),
    ...(appId === undefined ? {} : { app: { id: appId } }),
  };
}

function readItems(read) {
  if (read.stdout === undefined) {
    return read.checks ?? [];
  }
  try {
    const parsed = JSON.parse(read.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * A scripted `gh` for the check wait. Each entry of `reads` is `{ status, checks,
 * stdout, stderr }` and answers `gh pr checks`; the last entry repeats, so a wait that
 * polls more times than the script holds still answers. A `stdout` value is used verbatim,
 * which covers a read whose output is not a check list. The head read, `gh pr view <pr>
 * --json headRefOid`, answers the next entry of `heads`, and the last one repeats.
 * The check runs of a commit read by SHA come from `commits[sha]`, a list of
 * `{ name, state, bucket }` items; a commit the map does not hold answers with the items of
 * the latest `pr checks` read, so a test that scripts only `reads` sees one consistent source.
 * `statuses` lists the REST commit statuses of the commit, `[]` by default.
 * `required` lists the `{ name, appId }` contexts the base-branch ruleset requires; `rules`, `protection`, and `names` replace the reply of the ruleset read, the classic-protection read, and the required-names read. A call that is none of these is an error, so a test never passes on a missing fixture or a
 * wrong argument.
 */
export function scriptedGh(
  reads,
  {
    all = false,
    heads = [HEAD_A],
    commits = {},
    statuses = [],
    required = [],
    rules,
    protection,
  } = {},
) {
  let n = 0;
  let h = 0;
  let current = [];
  let lastRead = null;
  return async (args, cwd) => {
    if (isHeadRead(args)) {
      return headReply(heads[Math.min(h++, heads.length - 1)]);
    }
    if (args[0] === "repo" && args[1] === "view") {
      return ok("owner/repo");
    }
    if (isPagedRead(args, "/rules/branches/main") && rules) {
      return rules;
    }
    if (
      args[0] === "api" &&
      args[1] === "repos/owner/repo/branches/main/protection" &&
      protection
    ) {
      return protection;
    }
    if (isPagedRead(args, "/rules/branches/main")) {
      return ok(
        pageStdout(
          required.length === 0
            ? []
            : [
                {
                  type: "required_status_checks",
                  parameters: {
                    required_status_checks: required.map(({ name, appId }) => ({
                      context: name,
                      integration_id: appId,
                    })),
                  },
                },
              ],
        ),
      );
    }
    if (args[0] === "api" && args[1] === "repos/owner/repo/branches/main/protection") {
      return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (
      args.length === 6 &&
      startsWithArgs(args, ["pr", "checks"]) &&
      equalsArgs(args.slice(3), ["--required", "--json", "name"])
    ) {
      // The required-names read of the gate: the names of the latest `pr checks` read.
      return {
        status: lastRead.status,
        stdout: lastRead.stdout ?? JSON.stringify(current.map(({ name }) => ({ name }))),
        stderr: lastRead.stderr ?? "",
        timedOut: false,
      };
    }
    // The reads of the Actions hold: a base branch with no workflow file and a PR with no file, so a
    // test that scripts no workflow never holds for a run.
    const endpoint = args[0] === "api" ? args[1] : "";
    if (endpoint === "repos/owner/repo/commits/main") {
      return ok(pageStdout({ sha: "c".repeat(40) }));
    }
    if (endpoint.startsWith("repos/owner/repo/pulls/") && endpoint.includes("/files")) {
      return ok(pageStdout([]));
    }
    if (endpoint.startsWith("repos/owner/repo/contents/.github/workflows")) {
      return {
        status: 1,
        stdout:
          'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}',
        stderr: "gh: Not Found (HTTP 404)",
        timedOut: false,
      };
    }
    const api = /^repos\/owner\/repo\/commits\/([0-9a-f]+)\/(check-runs|status)(?:\?.*)?$/.exec(
      args[0] === "api" ? args[1] : "",
    );
    if (api) {
      const items = commits[api[1]] ?? current;
      const page = api[2] === "check-runs" ? { check_runs: items.map(runOfItem) } : { statuses };
      // Each page read gets its one page behind a `200` status block, the form of `gh api --include`.
      return ok(pageStdout(page));
    }
    if (!isCheckWaitRead(args, all)) {
      return {
        status: 1,
        stdout: "",
        stderr: `unmatched gh call: ${JSON.stringify(args)} (${cwd})`,
      };
    }
    const read = reads[Math.min(n++, reads.length - 1)];
    current = readItems(read);
    lastRead = read;
    return {
      status: read.status,
      stdout: read.stdout ?? JSON.stringify(read.checks ?? []),
      stderr: read.stderr ?? "",
      timedOut: read.timedOut ?? false,
    };
  };
}

// A fake clock: `sleep` advances it by the requested milliseconds, so the wait
// runs to completion without wall-clock time and the elapsed bound is checkable.
export function fakeClock() {
  const clock = { now: 0, slept: 0 };
  return {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.slept += ms;
      clock.now += ms;
    },
    elapsed: () => clock.now,
  };
}
