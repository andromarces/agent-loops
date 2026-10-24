// Fixtures shared by the ci-gate test files: the PR, check-run, and ruleset replies and the `gh` double that serves them.
import { equalsArgs, pagedApiArgs, pageStdout } from "../runtime-helpers.mjs";

export const HEAD = "1111111111111111111111111111111111111111";

export const MERGE = "2222222222222222222222222222222222222222";

export const SLUG = "andromarces/agent-loops";

export function prInfo(overrides = {}) {
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

let nextId = 1;

export function run(name, conclusion) {
  return {
    id: nextId++,
    name,
    status: "completed",
    conclusion,
    started_at: "2026-01-01T00:00:00Z",
  };
}

// A run that has not completed, and a commit status, with the fields the status
// read orders entries by.
export const openRun = (name, status = "in_progress") => ({
  id: nextId++,
  name,
  status,
  conclusion: null,
  started_at: "2026-01-01T00:00:00Z",
});

export const commitStatus = (context, state, updatedAt = "2026-01-01T00:00:00Z") => ({
  id: nextId++,
  context,
  state,
  updated_at: updatedAt,
});

// The route of one page of a paged read: the exact request, with the page number and no
// `--paginate`. The replies of such a route are the one page, behind a `200` status block.
export const pageRoute = (endpoint, page = 1) => pagedApiArgs(endpoint, page).join(" ");

// Routes a `gh` call by the leading elements of its argument array, so a call
// that merges arguments into one element gets no reply. A paged route answers a success with one
// page behind a `200` status block, as `gh api --include` writes it. A `hidden` value answers
// with the 404 a token without repository admin receives, a `forbidden` value
// with the 403 a `GITHUB_TOKEN` receives, a `pat forbidden` value with the 403 a
// fine-grained PAT without the Administration permission receives, a
// `rate limited` value with a 403 that is not an unreadable-source answer. A
// `stderr: <text>` value fails with that exact stderr, which covers the Free-plan
// 403 and every other reply shape a named value does not. An unmatched call is
// an error so a test never passes on a missing fixture. `null` is the admin
// reply for a branch with no classic protection, which is also unreadable but
// says so differently.
export function fakeGh(routes) {
  return async (args) => {
    for (const [match, value] of routes) {
      if (equalsArgs(args, match.split(" "))) {
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
        const body = typeof value === "string" ? value : JSON.stringify(value);
        return {
          status: 0,
          stdout: args.includes("--include") ? pageStdout(body) : body,
          stderr: "",
        };
      }
    }
    return { status: 1, stdout: "", stderr: `unmatched gh call: ${JSON.stringify(args)}` };
  };
}

// The `gh` calls the gate makes, each as the exact argument elements it passes, so
// a call that merges two elements into one gets no route (issue #538).
export const PR_VIEW =
  "pr view 42 --json headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit";

export const PR_CHECKS = "pr checks 42 --required --json name";

export const REPO_VIEW = "repo view --json nameWithOwner -q .nameWithOwner";

export const RULES_PAGE = pageRoute(`repos/${SLUG}/rules/branches/main`);

export const MERGE_CHECK_RUNS = pageRoute(`repos/${SLUG}/commits/${MERGE}/check-runs`);

export const MERGE_STATUS = pageRoute(`repos/${SLUG}/commits/${MERGE}/status`);

const HEAD_CHECK_RUNS = pageRoute(`repos/${SLUG}/commits/${HEAD}/check-runs`);

const HEAD_STATUS = pageRoute(`repos/${SLUG}/commits/${HEAD}/status`);

// The routes of a commit status read that spans pages: page `k` lists `pages[k - 1]`, and every
// page but the last is padded with filler statuses to the 100 a full page holds, so the read goes on.
// `total_count` is the padded total, as the endpoint reports it.
export function statusPageRoutes(commit, pages) {
  const full = pages.map((statuses, i) =>
    i === pages.length - 1
      ? statuses
      : [
          ...statuses,
          ...Array.from({ length: 100 - statuses.length }, (_, n) =>
            commitStatus(`filler ${i}.${n}`, "success"),
          ),
        ],
  );
  const total = full.flat().length;
  return full.map((statuses, i) => [
    pageRoute(`repos/${SLUG}/commits/${commit}/status`, i + 1),
    { total_count: total, statuses },
  ]);
}

// `table` with the status read of `commit` replaced by the pages of `statusPageRoutes`.
export const withStatusPages = (table, pages, commit = HEAD) => {
  const replaced = pageRoute(`repos/${SLUG}/commits/${commit}/status`);
  return [...table.filter(([match]) => match !== replaced), ...statusPageRoutes(commit, pages)];
};

// One route per page of the ruleset read, for `pages`, the list of rules of each page.
const rulesetRoutes = (pages) =>
  pages.map((rules, i) => [pageRoute(`repos/${SLUG}/rules/branches/main`, i + 1), rules]);

export function routes({
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
    [PR_VIEW, info],
    [PR_CHECKS, prChecks],
    [REPO_VIEW, SLUG],
    // The ruleset read pages by number, so each reply is one page: a list of rules.
    ...rulesetRoutes(requiredPages ?? [required]),
    [`api repos/${SLUG}/branches/main/protection`, protection],
    [MERGE_CHECK_RUNS, { check_runs: mergeRuns }],
    [MERGE_STATUS, { statuses: mergeStatuses }],
    [HEAD_CHECK_RUNS, { check_runs: headRuns }],
    [HEAD_STATUS, { statuses: headStatuses }],
  ];
}

export const REVIEWED = { head: HEAD, clean: true, exact: true, digest: "d" };

// Two entries for "ci (windows-latest)", the earlier-listed one failing and the
// later-listed one passing, as check runs and as commit statuses.
export const pairOptions = (kind, failing, passing) =>
  kind === "check runs"
    ? {
        headRuns: [
          run("ci (ubuntu-latest)", "success"),
          { ...run("ci (windows-latest)", "failure"), ...failing },
          { ...run("ci (windows-latest)", "success"), ...passing },
        ],
      }
    : {
        headRuns: [run("ci (ubuntu-latest)", "success")],
        headStatuses: [
          { ...commitStatus("ci (windows-latest)", "failure"), ...failing },
          { ...commitStatus("ci (windows-latest)", "success"), ...passing },
        ],
      };

// Holds each call of a group until every call of that group has started, and
// fails the held call when the rest of the group does not start within `waitMs`.
// A gate that starts its independent reads one after another never reaches the
// last call of a group while the first is held.
export function barrierGh(inner, groups, waitMs = 1000) {
  const pending = groups.map((members) => ({ members, started: new Set(), waiters: [] }));
  return async (args, cwd) => {
    const key = args.join(" ");
    const group = pending.find(({ members }) => members.includes(key));
    if (group) {
      group.started.add(key);
      if (group.started.size === group.members.length) {
        for (const release of group.waiters) {
          release();
        }
      } else {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`independent calls ran in sequence at: ${key}`)),
            waitMs,
          );
          group.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    return inner(args, cwd);
  };
}

export const INDEPENDENT_GROUPS = [
  [PR_VIEW, REPO_VIEW],
  [RULES_PAGE, `api repos/${SLUG}/branches/main/protection`, PR_CHECKS],
  [MERGE_CHECK_RUNS, MERGE_STATUS],
];

// A gh double that counts the calls still running. A call whose key is in `stalled`
// never replies and ends only when its abort signal fires, as a hung `gh` child
// ends when the runner kills it.
export function stallingGh(inner, stalled, abortDelayMs = 0) {
  const live = { active: 0 };
  const gh = async (args, cwd, options = {}) => {
    live.active += 1;
    try {
      if (stalled.includes(args.join(" "))) {
        await new Promise((_resolve, reject) => {
          const abort = () => setTimeout(() => reject(new Error("call aborted")), abortDelayMs);
          if (options.signal?.aborted) {
            abort();
          }
          options.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return await inner(args, cwd, options);
    } finally {
      live.active -= 1;
    }
  };
  return { gh, live };
}
