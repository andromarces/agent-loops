// Resolves the pull request that a worker turn opened, from Git and GitHub state only (ADR 0043).
// The runtime calls it after a worker turn of a headless run that has no PR input. No child turn
// names or changes the result.
import { readableErrorText } from "./error-message.mjs";
import { DEFAULT_READ_TIMEOUT_MS } from "./ci-gate.mjs";
import { ghFailureText, runGh } from "./ci-required-sources.mjs";
import { gitRead } from "./snapshot.mjs";

// Cap of the list read. A reply of this size holds too many PRs to name one, so it is ambiguous.
const LIST_LIMIT = 100;

const SCP_REMOTE = /^[^@\s/]+@([^:\s/]+):([^/\s]+)\/([^/\s]+)$/;

/**
 * The lowercase `host/owner/repo` identity of a GitHub repository URL, or null. A remote takes the
 * `https`, `http`, `ssh`, and `git` URL forms and the scp form `git@host:owner/repo`. A PR URL
 * (`pull`) takes the form `https://host/owner/repo/pull/<n>`.
 */
function repoIdentity(text, { pull = false } = {}) {
  const scp = pull ? null : SCP_REMOTE.exec(text);
  let host;
  let segments;
  if (scp) {
    [, host, ...segments] = scp;
  } else {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!(pull ? ["https:"] : ["https:", "http:", "ssh:", "git:"]).includes(url.protocol)) {
      return null;
    }
    host = url.hostname;
    segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== (pull ? 4 : 2) || (pull && segments[2] !== "pull")) return null;
    segments = segments.slice(0, 2);
  }
  const [owner, repo] = segments;
  const name = repo.replace(/\.git$/, "");
  return host && owner && name ? `${host}/${owner}/${name}`.toLowerCase() : null;
}

// One entry of the `gh pr list` reply as the resolver reads it. Any other shape is malformed.
const isListEntry = (entry) =>
  entry !== null &&
  typeof entry === "object" &&
  Number.isSafeInteger(entry.number) &&
  entry.number > 0 &&
  typeof entry.headRefName === "string" &&
  typeof entry.headRefOid === "string" &&
  typeof entry.isCrossRepository === "boolean" &&
  typeof entry.url === "string";

/**
 * Finds the one open PR whose head branch is the checked-out branch of `cwd`, whose base
 * repository is the repository of the remote of that branch, and whose head commit is `head`, the
 * work tree head that the runtime read after the worker turn. The work tree head is read again
 * after the `gh` read and must still equal `head`.
 * The branch remote is `branch.<branch>.remote`, or `origin` when none is set. `GH_REPO` can point
 * `gh` at another repository, so the base repository comes from the PR URL and is compared with the
 * remote URL, never with another `gh` answer.
 * Every other state leaves the run undeclared: a detached or unreadable branch, a remote that names
 * no GitHub repository, a failed or unparseable `gh` read, any malformed entry, no match, several
 * matches, a PR from a fork, a PR for another base repository, a PR head that differs from `head`,
 * and a work tree head that moved during the read. The function never throws.
 * @param {{ cwd: string, head: string | null, gh?: Function, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<{ pr: number } | { pr: null, reason: string, quiet?: true }>}
 */
export async function resolveWorkerPr({
  cwd,
  head,
  gh = runGh,
  signal,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
}) {
  if (typeof head !== "string" || head === "" || head === "unborn") {
    return { pr: null, reason: "the work tree head is not known" };
  }
  try {
    const branchRead = await gitRead(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { signal });
    const branch = branchRead.exitCode === 0 ? branchRead.stdout.trim() : "";
    if (branch === "") {
      return { pr: null, reason: "the work tree has no checked-out branch" };
    }
    const remoteRead = await gitRead(cwd, ["config", "--get", `branch.${branch}.remote`], {
      signal,
    });
    const configured = remoteRead.exitCode === 0 ? remoteRead.stdout.trim() : "";
    const remote = configured === "" || configured === "." ? "origin" : configured;
    const urlRead = await gitRead(cwd, ["remote", "get-url", remote], { signal });
    const runRepo = urlRead.exitCode === 0 ? repoIdentity(urlRead.stdout.trim()) : null;
    if (runRepo === null) {
      return { pr: null, reason: `remote ${remote} names no GitHub repository` };
    }
    const { status, stdout, stderr } = await gh(
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,headRefName,headRefOid,isCrossRepository,url",
        "--limit",
        String(LIST_LIMIT),
      ],
      cwd,
      { signal, timeoutMs },
    );
    if (status !== 0) {
      return { pr: null, reason: `gh pr list failed: ${ghFailureText({ status, stderr })}` };
    }
    const list = JSON.parse(stdout);
    if (!Array.isArray(list) || list.length >= LIST_LIMIT || !list.every(isListEntry)) {
      return { pr: null, reason: "the gh pr list reply is not a list that names one PR" };
    }
    const sameRepo = list.filter(
      (entry) => entry.headRefName === branch && !entry.isCrossRepository,
    );
    if (sameRepo.length === 0) {
      return { pr: null, reason: `no open PR from branch ${branch}`, quiet: true };
    }
    if (sameRepo.length > 1) {
      return { pr: null, reason: `${sameRepo.length} open PRs come from branch ${branch}` };
    }
    const [entry] = sameRepo;
    if (repoIdentity(entry.url, { pull: true }) !== runRepo) {
      return {
        pr: null,
        reason: `PR ${entry.number} is not in the repository of remote ${remote}`,
      };
    }
    if (entry.headRefOid !== head) {
      return {
        pr: null,
        reason: `PR ${entry.number} head differs from the work tree head ${head}`,
      };
    }
    const after = await gitRead(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { signal });
    if (after.exitCode !== 0 || after.stdout.trim() !== head) {
      return { pr: null, reason: "the work tree head changed during the PR read" };
    }
    return { pr: entry.number };
  } catch (err) {
    return { pr: null, reason: `the PR read failed: ${readableErrorText(err)}` };
  }
}
