// Cleanup of one batch loop (ADR 0106 decision 13). Only a pushed success is removed, and only
// while every identity, branch, cleanliness, claim, and work-tree-lock check passes. A head that
// is an ancestor of the current `origin/<base>` tip also proves the push.
import { canonicalPath, isInside } from "../lib/canonical-path.mjs";
import {
  commitsAhead,
  findRegisteredWorkTrees,
  identityEqual,
  fetchRemoteBranch,
  git,
  isAncestor,
  pathIdentity,
  readWorkTreeGitState,
  removeWorkTree,
} from "./git.mjs";
import { readGhJson } from "./gh-read.mjs";
import { readClaim, releaseClaim } from "./store.mjs";

const keep = (reason) => ({ removed: false, reason });

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The current `origin/<base>` tip commit, read from the remote rather than a cached tracking ref.
 * The tip object is fetched by ref name when it is missing. Returns null on any failed read.
 */
async function remoteBaseTip(repo, base) {
  const listed = await git(["ls-remote", "--exit-code", "origin", `refs/heads/${base}`], repo);
  const tip = listed.stdout.split(/\s+/)[0] ?? "";
  if (listed.exitCode !== 0 || !COMMIT_SHA.test(tip)) return null;
  const present = async () =>
    (await git(["cat-file", "-e", `${tip}^{commit}`], repo)).exitCode === 0;
  if (!(await present())) {
    const fetched = await git(["fetch", "origin", `refs/heads/${base}`], repo);
    if (fetched.exitCode !== 0) return null;
  }
  return (await present()) ? tip : null;
}

async function prProof({ loop, repo, base, gh, head }) {
  if (loop.pr === null || loop.pr === undefined)
    return keep("the loop has no pushed proof (unpushed)");
  let view;
  try {
    view = await readGhJson(
      gh,
      ["pr", "view", String(loop.pr), "--json", "state,headRefOid,mergeCommit"],
      repo,
    );
  } catch (err) {
    const noReply =
      err?.kind === "empty" || (err?.kind === "status" && (err.reply?.stderr ?? "").trim() === "");
    return keep(`the pull request read failed: ${noReply ? "no reply" : (err?.message ?? err)}`);
  }
  if (view?.state !== "MERGED") return keep(`pull request ${loop.pr} is not merged (unpushed)`);
  if (!(await isAncestor(head, view.headRefOid, repo))) {
    return keep("a local commit is not in the merged pull request (unpushed)");
  }
  const merge = view.mergeCommit?.oid;
  if (typeof merge !== "string" || !(await isAncestor(merge, `origin/${base}`, repo))) {
    return keep("the merge commit is not reachable from the base branch (unpushed)");
  }
  return { removed: true, reason: null };
}

/**
 * Removes one successful loop's work tree when its push, identity, claim, and lock proofs pass.
 * @returns {Promise<{ removed: boolean, reason: string | null }>}
 */
export async function cleanupLoop({ manifest, loop, runsRoot, gh = null }) {
  if (loop.status !== "succeeded") return keep(`the loop is ${loop.status}`);
  const workTree = loop.workTree;
  if (!workTree?.path) return keep("the recorded work tree is missing");

  if (
    loop.branch !== workTree.branch ||
    (await canonicalPath(workTree.path)) !== workTree.canonicalPath
  ) {
    return keep("the work tree identity changed");
  }
  const root = await canonicalPath(manifest.workTreeRoot);
  if (!isInside(root, workTree.canonicalPath)) {
    return keep("the path is outside the batch work-tree root");
  }
  if (workTree.canonicalPath === (await canonicalPath(manifest.repo))) {
    return keep("the main work tree is never removed");
  }
  const identity = await pathIdentity(workTree.path);
  if (identity === null) return keep("the recorded work tree is missing");
  if (!identityEqual(identity, workTree)) {
    return keep("the work tree identity changed");
  }

  const found = await findRegisteredWorkTrees(manifest.repo, workTree.canonicalPath);
  if (found.reason !== null) return keep(found.reason);
  if (found.own.length !== 1) return keep("the path is not the registered work tree of this batch");
  if (found.own[0].locked) return keep("the work tree is locked by a live run");

  const reads = await readWorkTreeGitState(workTree.path);
  const branch = reads.branch;
  if (branch.exitCode !== 0 || branch.stdout !== workTree.branch) {
    return keep("the recorded branch is not checked out");
  }
  const status = reads.status;
  if (status.exitCode !== 0 || status.stdout !== "") {
    return keep("the work tree is not clean");
  }
  const head = reads.head.stdout;

  const claim = await readClaim(runsRoot, manifest.repoKey, loop.issue);
  if (claim.exists) {
    if (!claim.parsed) return keep("the issue claim is held by an unreadable record");
    if (claim.record.batchId !== manifest.id)
      return keep("the issue claim belongs to another batch");
    if (claim.live && claim.record.pid !== process.pid) {
      return keep("the issue claim is held by a live process");
    }
  }

  const remote = await fetchRemoteBranch(manifest.repo, workTree.branch);
  let pushed = false;
  if (remote !== null) {
    const ahead = await commitsAhead(remote, workTree.branch, workTree.path);
    pushed = (await isAncestor(head, remote, manifest.repo)) && ahead === 0;
  }
  if (!pushed) {
    const baseTip = await remoteBaseTip(manifest.repo, manifest.base);
    if (baseTip === null) return keep("the base branch read failed (unpushed)");
    pushed = await isAncestor(head, baseTip, manifest.repo);
  }
  if (!pushed) {
    if (gh === null) return keep("no pushed proof (unpushed)");
    const proof = await prProof({ loop, repo: manifest.repo, base: manifest.base, gh, head });
    if (!proof.removed) return proof;
  }

  const removed = await removeWorkTree(manifest.repo, workTree.path, {
    dev: workTree.dev,
    ino: workTree.ino,
  });
  if (!removed.removed) return keep(removed.reason ?? "the removal failed");
  await releaseClaim(runsRoot, manifest.repoKey, loop.issue, { batchId: manifest.id });
  return { removed: true, reason: null };
}
