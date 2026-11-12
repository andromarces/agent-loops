// Reconciliation of an uncertain GitHub write before any repeat (ADR 0106 decision 11). The batch
// never force-pushes, resets, merges, or deletes a branch to make a state fit; an ambiguous state
// stops the loop as needs-owner.
import { isJsonObject } from "../lib/json.mjs";
import { canonicalPath } from "../lib/canonical-path.mjs";
import { readGhJson } from "./gh-read.mjs";
import { readFile } from "node:fs/promises";
import {
  commitsAhead,
  git as gitRead,
  identityEqual,
  isAncestor,
  pathIdentity,
  readWorkTreeGitState,
} from "./git.mjs";

const asGit = (deps) => deps.git ?? gitRead;

async function ghJson(gh, args, cwd, label) {
  try {
    return await readGhJson(gh, args, cwd);
  } catch (err) {
    if (err?.kind === "json") throw new Error(`${label} returned unreadable JSON`);
    if (err?.kind === "empty") throw new Error(`${label} failed: no reply`);
    if (err?.kind === "status" && (err.reply?.stderr ?? "").trim() === "") {
      throw new Error(`${label} failed: no reply`);
    }
    throw new Error(`${label} failed: ${err?.message ?? err}`);
  }
}

const owner = (reason) => ({ status: "needs-owner", reason, pr: null, requireCi: null });

// The success of a merged pull request, or null when no merged head matches the local branch.
async function mergedOutcome(merged, workTree, git) {
  for (const pull of merged) {
    const ahead = await commitsAhead(pull.headRefOid, workTree.branch, workTree.path, {
      runner: git,
    });
    if (ahead === null) return owner("the local commit count could not be read");
    if (ahead === 0) {
      return { status: "succeeded", reason: null, pr: pull.number, requireCi: null };
    }
  }
  return null;
}

/**
 * The work-tree heads that this loop's own transcript recorded for a worker or reviewer turn.
 * `data` is the already-parsed transcript, or undefined to read the recorded file.
 */
async function readRecordedHeads(loop, data) {
  if (data === undefined) {
    if (typeof loop.transcript !== "string") return [];
    try {
      data = JSON.parse(await readFile(loop.transcript, "utf8"));
    } catch {
      return [];
    }
  }
  if (!isJsonObject(data) || !Array.isArray(data.events)) return [];
  const heads = [];
  for (const event of data.events) {
    if (event?.type !== "result") continue;
    for (const head of [event.result?.workTree?.head, event.result?.reviewed?.head]) {
      if (typeof head === "string") heads.push(head);
    }
  }
  return heads;
}

/**
 * Reconciles one pull request item against its frozen head. A review-only loop reads no push
 * state; a work loop continues while its local branch matches, or is ahead of, the frozen head.
 */
async function reconcilePullRequest({ loop, repo, gh, git, state, headsOf }) {
  let view;
  try {
    view = await ghJson(
      gh,
      ["pr", "view", String(loop.pr), "--json", "state,headRefOid,headRefName,isCrossRepository"],
      repo,
      `the read of pull request ${loop.pr}`,
    );
    if (!isJsonObject(view) || typeof view.state !== "string") {
      throw new Error(`the read of pull request ${loop.pr} named no state`);
    }
  } catch (err) {
    return owner(err.message);
  }
  if (view.state === "MERGED") {
    if (state.head === view.headRefOid) {
      return { status: "succeeded", reason: null, pr: loop.pr, requireCi: null };
    }
    return owner(`pull request ${loop.pr} is merged with another head`);
  }
  if (view.state !== "OPEN") {
    return owner(`pull request ${loop.pr} is closed without a merge`);
  }
  const moved = typeof loop.head === "string" && view.headRefOid !== loop.head;
  if (moved) {
    const recorded = loop.mode === "review-only" ? [] : await headsOf(loop);
    const ownPush =
      loop.mode !== "review-only" &&
      state.head === view.headRefOid &&
      typeof loop.head === "string" &&
      recorded.includes(view.headRefOid) &&
      (await git(["merge-base", "--is-ancestor", loop.head, state.head], repo)).exitCode === 0;
    if (!ownPush) {
      return owner(
        `pull request ${loop.pr} head moved: the frozen head is ${loop.head}, the current head is ${view.headRefOid}`,
      );
    }
  }
  if (!state.clean) return owner("the work tree is not clean");
  if (loop.mode === "review-only") {
    if (state.head !== view.headRefOid) {
      return owner(`the local head differs from the head of pull request ${loop.pr}`);
    }
    return { status: "resume", reason: null, pr: null, requireCi: null };
  }
  const fetched = await git(["fetch", "origin", view.headRefName ?? loop.branch], repo);
  if (fetched.exitCode !== 0) return owner("the remote branch could not be read");
  const remote = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${view.headRefName ?? loop.branch}`],
    repo,
  );
  if (remote.exitCode !== 0 || remote.stdout === "") {
    return owner("the remote branch could not be read");
  }
  if (state.head !== remote.stdout) {
    const ancestor = await git(["merge-base", "--is-ancestor", remote.stdout, state.head], repo);
    if (ancestor.exitCode !== 0) return owner("the remote branch head differs from the local head");
  }
  return { status: "resume", reason: null, pr: loop.pr, requireCi: loop.pr };
}

/**
 * Reads the loop's local and remote state and applies the reconciliation rules.
 * `loop` holds `workTree` (`path`, `canonicalPath`, `dev`, `ino`, `branch`) and `pr` (declared).
 * `transcript` is the already-parsed transcript, or undefined to read the recorded file.
 * @returns {Promise<{ status: "resume" | "succeeded" | "needs-owner", reason: string | null, pr: number | null, requireCi: number | null }>}
 */
export async function reconcileLoop({ loop, repo, base, gh, deps = {}, transcript }) {
  const git = asGit(deps);
  const canonical = deps.canonicalPath ?? canonicalPath;
  const headsOf = deps.recordedHeads ?? ((target) => readRecordedHeads(target, transcript));
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
    const reads = await readWorkTreeGitState(workTree.path, { runner: git });
    const { branch, head, status } = reads;
    if (branch.exitCode !== 0 || head.exitCode !== 0 || status.exitCode !== 0) {
      throw new Error(branch.stderr || head.stderr || status.stderr || "a Git read failed");
    }
    state = { branch: branch.stdout, head: head.stdout, clean: status.stdout === "" };
  } catch (err) {
    return owner(`the work tree read failed: ${err.message}`);
  }
  const detached = loop.workTree?.detached === true;
  if (detached ? state.branch !== "HEAD" : state.branch !== workTree.branch) {
    return owner("another branch is checked out in the work tree");
  }
  if (loop.kind === "pr") {
    return reconcilePullRequest({ loop, repo, gh, git, state, headsOf });
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
        "number,state,headRefOid,isCrossRepository,baseRefName,mergeCommit",
      ],
      repo,
      "the pull request list read",
    );
    if (!Array.isArray(pulls)) throw new Error("the pull request list read returned no list");
    for (const pull of pulls) {
      if (!isJsonObject(pull) || !Number.isInteger(pull.number) || typeof pull.state !== "string") {
        throw new Error("the pull request list read returned a malformed entry");
      }
    }
    if (loop.kind === "task") {
      issue = { state: "OPEN", closedByPullRequestsReferences: [] };
    } else {
      issue = await ghJson(
        gh,
        ["issue", "view", String(loop.issue), "--json", "state,closedByPullRequestsReferences"],
        repo,
        "the issue read",
      );
      if (!isJsonObject(issue) || typeof issue.state !== "string") {
        throw new Error("the issue read named no state");
      }
    }
  } catch (err) {
    return owner(err.message);
  }

  const details = pulls;
  const recordedPr = loop.pr ?? loop.prUndeclared ?? null;

  if (recordedPr !== null) {
    if (!details.some((pull) => pull.number === recordedPr)) {
      return owner(
        loop.pr !== null
          ? `the transcript declares pull request ${recordedPr}, and the read does not find it`
          : `the transcript records undeclared pull request ${recordedPr}, and the read does not find it`,
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
  if (Number.isInteger(recordedPr)) ownNumbers.add(recordedPr);
  for (const reference of references) {
    if (Number.isInteger(reference?.number) && !ownNumbers.has(reference.number)) {
      return owner(`the issue is closed by pull request ${reference.number} of another branch`);
    }
  }
  const merged = details.filter((pull) => pull.state === "MERGED");
  const open = details.filter((pull) => pull.state === "OPEN");
  const closedUnmerged = details.filter((pull) => pull.state === "CLOSED");

  if (loop.kind === "task") {
    if (merged.length > 0) {
      const succeeded = await mergedOutcome(merged, workTree, git);
      if (succeeded !== null) return succeeded;
      return owner("the merged pull request head lacks a local commit");
    }
  }

  if (closed) {
    if (merged.length === 0) {
      return owner("the issue is closed and no pull request of this branch is merged");
    }
    const succeeded = await mergedOutcome(merged, workTree, git);
    if (succeeded !== null) return succeeded;
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
    // A loop whose only recorded pull request is undeclared keeps the head compare. A
    // required-check gate for that pull request refuses every finish on an unreadable source.
    if (loop.pr == null && loop.prUndeclared != null) {
      return { status: "resume", reason: null, pr: null, requireCi: null };
    }
    return { status: "resume", reason: null, pr: pull.number, requireCi: pull.number };
  }

  if (remoteHead !== null && remoteHead !== state.head) {
    const ahead = await commitsAhead(remoteHead, state.head, workTree.path, { runner: git });
    const remoteIsAncestor = await isAncestor(remoteHead, state.head, workTree.path, {
      runner: git,
    });
    if (ahead === null) return owner("the local commit count could not be read");
    if (ahead > 0 && remoteIsAncestor) {
      return { status: "resume", reason: null, pr: null, requireCi: null };
    }
    return owner("the remote branch head differs from the local head");
  }
  return { status: "resume", reason: null, pr: null, requireCi: null };
}
