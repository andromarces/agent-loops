// Cleanup of one batch loop (ADR 0106 decision 13). Only a pushed success is removed, and only
// while every identity, branch, cleanliness, claim, and work-tree-lock check passes.
import { canonicalPath } from "../lib/canonical-path.mjs";
import {
  commitsAhead,
  fetchRemoteBranch,
  git,
  isAncestor,
  isInside,
  pathIdentity,
  readRegisteredWorkTrees,
  removeWorkTree,
} from "./git.mjs";
import { readClaim, releaseClaim } from "./store.mjs";

const keep = (reason) => ({ removed: false, reason });

async function prProof({ loop, repo, base, gh }) {
  if (loop.pr === null || loop.pr === undefined)
    return keep("the loop has no pushed proof (unpushed)");
  let view;
  try {
    const reply = await gh(
      ["pr", "view", String(loop.pr), "--json", "state,headRefOid,mergeCommit"],
      repo,
    );
    if (reply?.status !== 0) throw new Error((reply?.stderr ?? "").trim() || "no reply");
    view = JSON.parse(reply.stdout);
  } catch (err) {
    return keep(`the pull request read failed: ${err?.message ?? err}`);
  }
  if (view?.state !== "MERGED") return keep(`pull request ${loop.pr} is not merged (unpushed)`);
  const head = (await git(["rev-parse", "HEAD"], loop.workTree.path)).stdout;
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
  if (identity.dev !== workTree.dev || identity.ino !== workTree.ino) {
    return keep("the work tree identity changed");
  }

  let entries;
  try {
    entries = await readRegisteredWorkTrees(manifest.repo);
  } catch (err) {
    return keep(`the work tree list read failed: ${err.message}`);
  }
  const own = [];
  for (const entry of entries) {
    if ((await canonicalPath(entry.path)) === workTree.canonicalPath) own.push(entry);
  }
  if (own.length !== 1) return keep("the path is not the registered work tree of this batch");
  if (own[0].locked) return keep("the work tree is locked by a live run");

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], workTree.path);
  if (branch.exitCode !== 0 || branch.stdout !== workTree.branch) {
    return keep("the recorded branch is not checked out");
  }
  const status = await git(["status", "--porcelain"], workTree.path);
  if (status.exitCode !== 0 || status.stdout !== "") {
    return keep("the work tree is not clean");
  }

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
    const head = (await git(["rev-parse", "HEAD"], workTree.path)).stdout;
    const ahead = await commitsAhead(remote, workTree.branch, workTree.path);
    pushed = (await isAncestor(head, remote, manifest.repo)) && ahead === 0;
  }
  if (!pushed) {
    if (gh === null) return keep("no pushed proof (unpushed)");
    const proof = await prProof({ loop, repo: manifest.repo, base: manifest.base, gh });
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
