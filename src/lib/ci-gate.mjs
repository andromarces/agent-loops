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

// A source the caller cannot read answers 404 or 403, and the message names the
// credential. Observed live on the classic-protection endpoint (#280):
//
//   `Not Found`                             404  a token without repository admin
//   `Branch not protected`                  404  an admin, on a branch with no
//                                                  classic protection, which is not
//                                                  an unreadable source
//   `Resource not accessible by integration` 403  a `GITHUB_TOKEN`
//
// All three mean the same thing to this gate, that the source contributes no
// required contexts, and the caller refuses an empty union either way.
//
// Match the message, not the status. `gh` renders every failure as
// `gh: <message> (HTTP <status>)`, so a rate-limit or SSO 403 carries the same
// suffix as the `GITHUB_TOKEN` 403 and the status cannot tell them apart. Reading
// a rate-limit 403 as an unreadable source would silently drop every required
// context and downgrade a named check refusal to the generic blocked refusal, so
// anything unrecognized throws instead. A narrower match only costs a thrown
// error, which still fails closed.
//
// `Not Found` is safe to read as unreadable on these two calls: the slug comes
// from `gh repo view` and the base branch from the pull request, both of which
// the caller has already read successfully, so a 404 here cannot be a typo in
// either.
//
// known-limit: a fine-grained PAT without the Administration permission is
// expected to answer `Resource not accessible by personal access token` (403),
// which is not observed, because no such token was available. It throws rather
// than contributing no contexts, which still refuses the finish. Widen this
// pattern when that reply is observed.
const UNREADABLE =
  /(?:Not Found|Branch not protected) \(HTTP 404\)|Resource not accessible by integration \(HTTP 403\)/;

async function ghApi(gh, args, cwd, { allowUnreadable = false } = {}) {
  const { status, stdout, stderr } = await gh(["api", ...args], cwd);
  if (status !== 0) {
    if (allowUnreadable && UNREADABLE.test(stderr)) {
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
      "headRefOid,baseRefName,mergeStateStatus,potentialMergeCommit",
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

// `gh pr checks --required` resolves required check names without admin rights.
// It lists only checks that already reported on the commit, exits non-zero for
// pending or failing checks, and prints no JSON when no required check has
// reported, so the output is parsed leniently and an unparseable result
// contributes no names. This source carries no app qualifier, so every name it
// yields is unqualified.
async function ghRequiredNames(gh, pr, cwd) {
  const { stdout } = await gh(["pr", "checks", String(pr), "--required", "--json", "name"], cwd);
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed.map((check) => check?.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// A required status context: its name, plus the id of the app whose check run
// must satisfy it when the source qualifies the context with one. A null `appId`
// is unqualified and is satisfied by a check run or a commit status with the
// name. Ruleset entries carry `integration_id`, classic-protection entries carry
// `app_id`, and `gh pr checks --required` carries no app qualifier.
function contextKey(name, appId) {
  return `${name}\0${appId ?? ""}`;
}

function addContext(contexts, name, appId = null) {
  if (name) {
    // A source can report `-1` as the "any app" qualifier; treat it as absent.
    const qualifier = appId == null || appId === -1 ? null : appId;
    contexts.set(contextKey(name, qualifier), { name, appId: qualifier });
  }
}

// Required status contexts from every source the caller can read: repository
// rulesets, classic branch protection, and `gh pr checks --required`.
// Deduplicated by name and app qualifier. An unreadable source contributes no
// contexts; the caller refuses an empty union, so a source that yields no
// contexts fails closed instead of passing vacuously.
async function requiredContexts(gh, slug, base, pr, cwd) {
  const contexts = new Map();

  const rules = await ghApi(gh, [`repos/${slug}/rules/branches/${base}`], cwd, {
    allowUnreadable: true,
  });
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule?.type !== "required_status_checks") {
        continue;
      }
      for (const check of rule.parameters?.required_status_checks ?? []) {
        addContext(contexts, check?.context, check?.integration_id);
      }
    }
  }

  const protection = await ghApi(gh, [`repos/${slug}/branches/${base}/protection`], cwd, {
    allowUnreadable: true,
  });
  const required = protection?.required_status_checks;
  for (const context of required?.contexts ?? []) {
    addContext(contexts, context);
  }
  for (const check of required?.checks ?? []) {
    addContext(contexts, check?.context, check?.app_id);
  }

  for (const name of await ghRequiredNames(gh, pr, cwd)) {
    addContext(contexts, name);
  }

  // An unqualified copy of an app-qualified name cannot express which app must
  // pass, so it would judge the name by the newest run from any app and could
  // refuse a passing qualified check. Drop it in favor of the qualified
  // context, which the per-context check enforces.
  const values = [...contexts.values()];
  const qualifiedNames = new Set(
    values.filter((context) => context.appId !== null).map((context) => context.name),
  );
  return values
    .filter((context) => context.appId !== null || !qualifiedNames.has(context.name))
    .sort((a, b) => {
      const left = contextKey(a.name, a.appId);
      const right = contextKey(b.name, b.appId);
      return left < right ? -1 : left > right ? 1 : 0;
    });
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

// Null when the required context passes, or a reason that names the failing
// condition. An app-qualified context is satisfied only by a check run from that
// app; an unqualified context is satisfied by a check run or a commit status
// with the name, and both types must pass when both carry an unqualified name.
function evaluateContext({ name, appId }, commit, runs, statuses) {
  const label = appId === null ? `"${name}"` : `"${name}" (app ${appId})`;
  const matchingRuns = runs.filter(
    (run) => run.name === name && (appId === null || run.app?.id === appId),
  );
  // A commit status carries no app, so it can never satisfy an app-qualified
  // context.
  const matchingStatuses =
    appId === null ? statuses.filter((status) => status.context === name) : [];

  if (matchingRuns.length === 0 && matchingStatuses.length === 0) {
    return `required check ${label} is missing on ${commit}`;
  }

  if (matchingRuns.length > 0) {
    const run = latestRun(matchingRuns);
    if (run.status !== "completed") {
      return `required check ${label} is pending (check run status ${run.status})`;
    }
    if (!PASS_CHECK_CONCLUSIONS.has(run.conclusion)) {
      return `required check ${label} failed (check run conclusion ${run.conclusion})`;
    }
  }

  if (matchingStatuses.length > 0) {
    const status = latestStatus(matchingStatuses);
    if (status.state !== "success") {
      return `required check ${label} failed (commit status ${status.state})`;
    }
  }

  return null;
}

/**
 * Refuses unless the PR head equals the reviewed commit, the reviewed tree is
 * clean, the PR is not behind its base under a strict rule, has no merge
 * conflicts, is not in an unknown merge state, and every required check passed
 * on the commit GitHub evaluates. A blocked merge state refuses after the
 * per-check pass, so a named check refusal keeps its name; any remaining block
 * (a required check that never reported, a required review, or another required
 * rule) fails closed. Refuses when no required checks are found, so an empty
 * source fails closed.
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
    return fail("GitHub reports the PR merge state as unknown (computed lazily; retry shortly)");
  }
  if (info.mergeStateStatus === "DIRTY") {
    return fail("the PR has merge conflicts (merge state DIRTY)");
  }
  if (info.headRefOid !== reviewed.head) {
    return fail("the PR head differs from the reviewed commit");
  }

  const slug = await repoSlug(gh, cwd);
  const required = await requiredContexts(gh, slug, info.baseRefName, pr, cwd);
  if (required.length === 0) {
    return fail("no required checks were found for the base branch");
  }
  const { commit, runs, statuses } = await evaluatedState(gh, slug, info, cwd);
  for (const context of required) {
    const reason = evaluateContext(context, commit, runs, statuses);
    if (reason) {
      return fail(reason);
    }
  }
  // Run this after the per-check pass so a named check refusal keeps its name.
  // `gh pr checks --required` lists only checks that already reported, so on a
  // classic-protection-only repo a caller without admin rights cannot enumerate
  // a required check that never started; GitHub reports that PR as blocked to such
  // a caller, confirmed live with a non-admin `GITHUB_TOKEN` (#280). When no other
  // required check reported, the empty-union refusal above fires first. The REST
  // `mergeable_state` reads `blocked` for an admin and `unstable` for an anonymous
  // caller on that same pull request, so its value depends on the viewer and is not
  // a stable signal. The GraphQL `mergeStateStatus` reads `BLOCKED` for the admin
  // and for a non-admin `GITHUB_TOKEN`, which is what was observed; GraphQL needs
  // authentication, so no anonymous reading of it exists (#280). Other unmet rules
  // (a required review, unresolved conversations, a required deployment) also report
  // blocked, and the gate cannot tell them apart, so it fails closed (#271).
  if (info.mergeStateStatus === "BLOCKED") {
    return fail(
      "the PR merge state is blocked (a required check, review, or other required rule is unmet)",
    );
  }

  return { ok: true, commit };
}
