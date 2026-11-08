// Reconciliation of an uncertain GitHub write before any repeat (ADR 0106 decision 11). The batch
// never force-pushes, resets, merges, or deletes a branch to make a state fit; an ambiguous state
// stops the loop as needs-owner.
import { isJsonObject } from "../lib/json.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { git as gitRead, identityEqual, pathIdentity } from "./git.mjs";

const asGit = (deps) => deps.git ?? gitRead;

async function commitsAhead(from, to, cwd, git) {
  const result = await git(["rev-list", "--count", `${from}..${to}`], cwd);
  return result.exitCode === 0 && /^\d+$/.test(result.stdout) ? Number(result.stdout) : null;
}

async function ancestorOf(ancestor, descendant, cwd, git) {
  const result = await git(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
  return result.exitCode === 0;
}

async function ghJson(gh, args, cwd, label) {
  let reply;
  try {
    reply = await gh(args, cwd);
  } catch (err) {
    throw new Error(`${label} failed: ${err?.message ?? err}`);
  }
  if (reply === undefined || reply === null || reply.status !== 0) {
    throw new Error(`${label} failed: ${(reply?.stderr ?? "").trim() || "no reply"}`);
  }
  try {
    return JSON.parse(reply.stdout);
  } catch {
    throw new Error(`${label} returned unreadable JSON`);
  }
}

const owner = (reason) => ({ status: "needs-owner", reason, pr: null, requireCi: null });

/**
 * Reads the loop's local and remote state and applies the reconciliation rules.
 * `loop` holds `workTree` (`path`, `canonicalPath`, `dev`, `ino`, `branch`) and `pr` (declared).
 * @returns {Promise<{ status: "resume" | "succeeded" | "needs-owner", reason: string | null, pr: number | null, requireCi: number | null }>}
 */
export async function reconcileLoop({ loop, repo, base, gh, deps = {} }) {
  const git = asGit(deps);
  const canonical = deps.canonicalPath ?? canonicalPath;
  const identityOf = deps.pathIdentity ?? pathIdentity;
  const workTree = loop.workTree;
  if (!workTree?.path || typeof workTree.path !== "string") {
    return owner("the recorded work tree is missing");
  }
  const identity = await identityOf(workTree.path);
  if (identity === null) return owner("the recorded work tree is missing");
  if (
    !identityEqual(identity, workTree) ||
    (await canonical(workTree.path)) !== workTree.canonicalPath
  ) {
    return owner("the recorded work tree identity changed");
  }
  let state;
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], workTree.path);
    const head = await git(["rev-parse", "HEAD"], workTree.path);
    const status = await git(["status", "--porcelain"], workTree.path);
    if (branch.exitCode !== 0 || head.exitCode !== 0 || status.exitCode !== 0) {
      throw new Error(branch.stderr || head.stderr || status.stderr || "a Git read failed");
    }
    state = { branch: branch.stdout, head: head.stdout, clean: status.stdout === "" };
  } catch (err) {
    return owner(`the work tree read failed: ${err.message}`);
  }
  if (state.branch !== workTree.branch) {
    return owner("another branch is checked out in the work tree");
  }

  const fetched = await git(["fetch", "origin", workTree.branch], repo);
  let remoteReadFailed = fetched.exitCode !== 0;
  let remoteHead = null;
  if (!remoteReadFailed) {
    const head = await git(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${workTree.branch}`],
      repo,
    );
    // A fetch that succeeded proves the ref should resolve, so a failed read is not an absent
    // branch.
    if (head.exitCode !== 0) remoteReadFailed = true;
    else remoteHead = head.stdout === "" ? null : head.stdout;
  }

  let pulls;
  let issue;
  try {
    pulls = await ghJson(
      gh,
      [
        "pr",
        "list",
        "--head",
        workTree.branch,
        "--state",
        "all",
        "--json",
        "number,state,headRefOid,isCrossRepository,baseRefName",
      ],
      repo,
      "the pull request list read",
    );
    if (!Array.isArray(pulls)) throw new Error("the pull request list read returned no list");
    for (const pull of pulls) {
      if (!isJsonObject(pull) || !Number.isInteger(pull.number)) {
        throw new Error("the pull request list read returned a malformed entry");
      }
    }
    issue = await ghJson(
      gh,
      ["issue", "view", String(loop.issue), "--json", "state,closedByPullRequestsReferences"],
      repo,
      "the issue read",
    );
    if (!isJsonObject(issue) || typeof issue.state !== "string") {
      throw new Error("the issue read named no state");
    }
  } catch (err) {
    return owner(err.message);
  }

  const details = [];
  for (const pull of pulls) {
    try {
      const view = await ghJson(
        gh,
        ["pr", "view", String(pull.number), "--json", "state,headRefOid,mergeCommit"],
        repo,
        `the read of pull request ${pull.number}`,
      );
      if (!isJsonObject(view) || typeof view.state !== "string") {
        throw new Error(`the read of pull request ${pull.number} named no state`);
      }
      details.push({ ...pull, ...view });
    } catch (err) {
      return owner(err.message);
    }
  }

  if (loop.pr !== null && loop.pr !== undefined) {
    if (!details.some((pull) => pull.number === loop.pr)) {
      return owner(
        `the transcript declares pull request ${loop.pr}, and the read does not find it`,
      );
    }
  }

  const closed = String(issue.state).toUpperCase() === "CLOSED";
  const references = Array.isArray(issue.closedByPullRequestsReferences)
    ? issue.closedByPullRequestsReferences
    : Array.isArray(issue.closedByPullRequestsReferences?.nodes)
      ? issue.closedByPullRequestsReferences.nodes
      : [];
  const ownNumbers = new Set(details.map((pull) => pull.number));
  for (const reference of references) {
    if (Number.isInteger(reference?.number) && !ownNumbers.has(reference.number)) {
      return owner(`the issue is closed by pull request ${reference.number} of another branch`);
    }
  }
  const merged = details.filter((pull) => pull.state === "MERGED");
  const open = details.filter((pull) => pull.state === "OPEN");
  const closedUnmerged = details.filter((pull) => pull.state === "CLOSED");

  if (closed) {
    if (merged.length === 0) {
      return owner("the issue is closed and no pull request of this branch is merged");
    }
    for (const pull of merged) {
      const ahead = await commitsAhead(pull.headRefOid, workTree.branch, workTree.path, git);
      if (ahead === null) return owner("the local commit count could not be read");
      if (ahead === 0)
        return { status: "succeeded", reason: null, pr: pull.number, requireCi: null };
    }
    return owner("the merged pull request head lacks a local commit");
  }

  if (remoteReadFailed) {
    return owner("the remote branch could not be read");
  }
  if (closedUnmerged.length > 0) {
    return owner(`pull request ${closedUnmerged[0].number} is closed without a merge`);
  }
  if (open.length > 1) return owner("more than one open pull request names the branch");
  if (open.length === 1) {
    const pull = open[0];
    if (pull.isCrossRepository === true) return owner("the pull request comes from a fork");
    if (pull.baseRefName !== undefined && pull.baseRefName !== base) {
      return owner(`pull request ${pull.number} targets another base branch`);
    }
    if (pull.headRefOid !== state.head) {
      return owner(`pull request ${pull.number} names another head`);
    }
    if (remoteHead === null || remoteHead !== state.head) {
      return owner("the remote branch head differs from the local head");
    }
    if (!state.clean) return owner("the work tree is not clean");
    return { status: "resume", reason: null, pr: pull.number, requireCi: pull.number };
  }

  if (remoteHead !== null && remoteHead !== state.head) {
    const ahead = await commitsAhead(remoteHead, state.head, workTree.path, git);
    const remoteIsAncestor = await ancestorOf(remoteHead, state.head, workTree.path, git);
    if (ahead === null) return owner("the local commit count could not be read");
    if (ahead > 0 && remoteIsAncestor) {
      return { status: "resume", reason: null, pr: null, requireCi: null };
    }
    return owner("the remote branch head differs from the local head");
  }
  return { status: "resume", reason: null, pr: null, requireCi: null };
}
