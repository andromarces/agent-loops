// Evaluates the `--require-ci` finish gate: every required status check passed
// on the commit GitHub evaluates for the pull request. Check runs and commit
// statuses are both considered, because a required name can appear as either
// type (issue #218).
//
// The `gh` runner is injected so a caller can run the gate against captured
// responses. The default runner shells out to the `gh` CLI.
import { execa } from "execa";

// A check run passes with one of these conclusions; every other conclusion and
// every non-completed status fails the gate.
const PASS_CHECK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** Runs `gh` with `args` in `cwd`. Returns `{ status, stdout, stderr }`; a non-zero exit is data, not a throw. */
export async function runGh(args, cwd) {
  const result = await execa("gh", args, { cwd, reject: false });
  return { status: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function fail(reason) {
  return { ok: false, reason };
}

async function ghApi(gh, args, cwd, { allow404 = false } = {}) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    if (allow404 && /HTTP 404|\b404\b/.test(stderr)) {
      return null;
    }
    throw new Error(`gh api ${args[0]} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}

async function prInfo(gh, pr, cwd) {
  const { status, stdout, stderr } = await gh(
    [
      "pr",
      "view",
      String(pr),
      "--json",
      "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit,state",
    ],
    cwd,
  );
  if (status !== 0) {
    throw new Error(`gh pr view ${pr} failed: ${stderr.trim() || `exit ${status}`}`);
  }
  return JSON.parse(stdout);
}

async function repoSlug(gh, cwd) {
  const { status, stdout, stderr } = await gh(
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    cwd,
  );
  if (status !== 0 || stdout.trim() === "") {
    throw new Error(`gh repo view failed: ${stderr.trim() || `exit ${status}`}`);
  }
  return stdout.trim();
}

// Required status contexts from repository rulesets and classic branch
// protection, deduplicated. The rules endpoint is absent on older hosts and the
// classic endpoint returns 404 when unprotected; both are treated as "no
// contexts" rather than a failure.
async function requiredContexts(gh, slug, base, cwd) {
  const contexts = new Set();

  const rules = await ghApi(gh, [`repos/${slug}/rules/branches/${base}`], cwd, { allow404: true });
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule?.type !== "required_status_checks") {
        continue;
      }
      for (const check of rule.parameters?.required_status_checks ?? []) {
        if (check?.context) {
          contexts.add(check.context);
        }
      }
    }
  }

  const protection = await ghApi(gh, [`repos/${slug}/branches/${base}/protection`], cwd, {
    allow404: true,
  });
  const required = protection?.required_status_checks;
  for (const context of required?.contexts ?? []) {
    if (context) {
      contexts.add(context);
    }
  }
  for (const check of required?.checks ?? []) {
    if (check?.context) {
      contexts.add(check.context);
    }
  }

  return [...contexts].sort();
}

async function checkRuns(gh, slug, sha, cwd) {
  const pages = await ghApi(
    gh,
    [`repos/${slug}/commits/${sha}/check-runs`, "--paginate", "--slurp"],
    cwd,
  );
  if (!Array.isArray(pages)) {
    return [];
  }
  return pages.flatMap((page) => page?.check_runs ?? []);
}

async function commitStatuses(gh, slug, sha, cwd) {
  const data = await ghApi(gh, [`repos/${slug}/commits/${sha}/status`], cwd);
  return data?.statuses ?? [];
}

// The commit GitHub evaluates: the test merge commit when it carries a check
// run or a commit status, the head commit otherwise. The same selection yields
// the result GitHub shows for the pull request.
async function evaluatedState(gh, slug, info, cwd) {
  const head = info.headRefOid;
  const merge = info.potentialMergeCommit?.oid ?? null;
  if (merge && merge !== head) {
    const runs = await checkRuns(gh, slug, merge, cwd);
    const statuses = await commitStatuses(gh, slug, merge, cwd);
    if (runs.length > 0 || statuses.length > 0) {
      return { commit: merge, runs, statuses };
    }
  }
  const runs = await checkRuns(gh, slug, head, cwd);
  const statuses = await commitStatuses(gh, slug, head, cwd);
  return { commit: head, runs, statuses };
}

// The most recent matching check run, by start time. GitHub evaluates the
// latest run for a name; an earlier failing run that a later run replaces does
// not fail the gate.
function latestRun(runs) {
  let latest = null;
  for (const run of runs) {
    const key = `${run.started_at ?? run.completed_at ?? ""}\0${run.id ?? 0}`;
    if (!latest || key >= latest.key) {
      latest = { key, run };
    }
  }
  return latest?.run ?? null;
}

function latestStatus(statuses) {
  let latest = null;
  for (const status of statuses) {
    const key = `${status.updated_at ?? status.created_at ?? ""}\0${status.id ?? 0}`;
    if (!latest || key >= latest.key) {
      latest = { key, status };
    }
  }
  return latest?.status ?? null;
}

// Null when `name` passes as a required check, or a reason that names the
// failing condition. Both types must pass when both carry the name.
function evaluateContext(name, commit, runs, statuses) {
  const matchingRuns = runs.filter((run) => run.name === name);
  const matchingStatuses = statuses.filter((status) => status.context === name);

  if (matchingRuns.length === 0 && matchingStatuses.length === 0) {
    return `required check "${name}" is missing on ${commit}`;
  }

  if (matchingRuns.length > 0) {
    const run = latestRun(matchingRuns);
    if (run.status !== "completed") {
      return `required check "${name}" is pending (check run status ${run.status})`;
    }
    if (!PASS_CHECK_CONCLUSIONS.has(run.conclusion)) {
      return `required check "${name}" failed (check run conclusion ${run.conclusion})`;
    }
  }

  if (matchingStatuses.length > 0) {
    const status = latestStatus(matchingStatuses);
    if (status.state !== "success") {
      return `required check "${name}" failed (commit status ${status.state})`;
    }
  }

  return null;
}

/**
 * Refuses unless the PR head equals the reviewed commit, the reviewed tree is
 * clean, the PR is not behind its base under a strict rule and not in an unknown
 * merge state, and every required check passed on the commit GitHub evaluates.
 * @param {{ pr: number, reviewed: object | null, cwd: string, gh?: Function }} options
 * @returns {Promise<{ ok: true, commit: string } | { ok: false, reason: string }>}
 */
export async function checkCi({ pr, reviewed, cwd, gh = runGh }) {
  if (!reviewed) {
    return fail("the latest reviewer turn has no reviewed state");
  }
  if (!reviewed.clean) {
    return fail("the reviewed work tree is not clean");
  }

  const info = await prInfo(gh, pr, cwd);
  if (info.mergeStateStatus === "BEHIND") {
    return fail("the PR is behind its base branch");
  }
  if (info.mergeStateStatus === "UNKNOWN") {
    return fail("GitHub reports the PR merge state as unknown");
  }
  if (info.headRefOid !== reviewed.head) {
    return fail("the PR head differs from the reviewed commit");
  }

  const slug = await repoSlug(gh, cwd);
  const required = await requiredContexts(gh, slug, info.baseRefName, cwd);
  const { commit, runs, statuses } = await evaluatedState(gh, slug, info, cwd);
  for (const name of required) {
    const reason = evaluateContext(name, commit, runs, statuses);
    if (reason) {
      return fail(reason);
    }
  }

  return { ok: true, commit };
}
