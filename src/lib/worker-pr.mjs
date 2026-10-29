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
 * (`pull`, the PR number) takes the form `https://host/owner/repo/pull/<number>`, and its last
 * segment must equal that number.
 */
function repoIdentity(text, { pull = null } = {}) {
  const scp = pull === null ? SCP_REMOTE.exec(text) : null;
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
    if (
      !(pull !== null ? ["https:"] : ["https:", "http:", "ssh:", "git:"]).includes(url.protocol)
    ) {
      return null;
    }
    host = url.hostname;
    segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== (pull !== null ? 4 : 2)) return null;
    if (pull !== null && (segments[2] !== "pull" || segments[3] !== String(pull))) return null;
    segments = segments.slice(0, 2);
  }
  const [owner, repo] = segments;
  const name = repo.replace(/\.git$/, "");
  return host && owner && name ? `${host}/${owner}/${name}`.toLowerCase() : null;
}

/**
 * Reads the Git state that the PR match depends on: the checked-out branch, the branch remote, the
 * identity of the remote repository, and the work tree head. A field that cannot be read is null.
 * The resolver reads it before and after the `gh` read and compares the two.
 */
async function readRunState(cwd, signal) {
  // The head read does not depend on the branch chain, so it runs beside it. A failure of the chain
  // throws first, as in sequential reads, and the head read settles before the throw.
  const headRead = gitRead(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { signal });
  headRead.catch(() => {});
  try {
    const branchRead = await gitRead(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { signal });
    const branch = branchRead.exitCode === 0 ? branchRead.stdout.trim() : "";
    if (branch === "") return { branch: null, remote: null, repo: null, head: null };
    const remoteRead = await gitRead(cwd, ["config", "--get", `branch.${branch}.remote`], {
      signal,
    });
    const configured = remoteRead.exitCode === 0 ? remoteRead.stdout.trim() : "";
    const remote = configured === "" || configured === "." ? "origin" : configured;
    const urlRead = await gitRead(cwd, ["remote", "get-url", remote], { signal });
    const repo = urlRead.exitCode === 0 ? repoIdentity(urlRead.stdout.trim()) : null;
    const head = (await headRead).exitCode === 0 ? (await headRead).stdout.trim() : null;
    return { branch, remote, repo, head };
  } finally {
    await headRead.catch(() => {});
  }
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
 * work tree head that the runtime read after the worker turn. The work tree head must equal `head`
 * before the `gh` read and after it. The branch and the remote repository must be unchanged by the
 * `gh` read.
 * The branch remote is `branch.<branch>.remote`, or `origin` when none is set. `GH_REPO` can point
 * `gh` at another repository, so the base repository comes from the PR URL and is compared with the
 * remote URL, never with another `gh` answer.
 * Every other state leaves the run undeclared: a detached or unreadable branch, a remote that names
 * no GitHub repository, a failed or unparseable `gh` read, any malformed entry, no match, several
 * matches, a PR from a fork, a PR for another base repository, a PR head that differs from `head`,
 * a PR URL that does not end in the PR number, and a head that differs from `head` before or
 * after the read. A branch or remote that changed during the read does the same. The function never throws.
 * `confirm(pr)` is an optional read that runs on the matched PR before the final identity check, so
 * that check covers it. It returns null to accept the PR, or the reason text that leaves the run
 * undeclared; that text is the runtime's own, so the result carries `trusted`, and `undeclaredPr`
 * names the matched PR that the read refused, for the head compare of ADR 0052 (#1111). A head,
 * branch, or remote that moved during the read names no PR.
 * @param {{ cwd: string, head: string | null, gh?: Function, signal?: AbortSignal, timeoutMs?: number, confirm?: (pr: number) => Promise<string | null> }} options
 * @returns {Promise<{ pr: number } | { pr: null, reason: string, quiet?: true, trusted?: true, undeclaredPr?: number }>}
 */
export async function resolveWorkerPr({
  cwd,
  head,
  gh = runGh,
  signal,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  confirm = null,
}) {
  if (typeof head !== "string" || head === "" || head === "unborn") {
    return { pr: null, reason: "the work tree head is not known" };
  }
  try {
    const before = await readRunState(cwd, signal);
    const { branch, remote, repo: runRepo } = before;
    if (branch === null) {
      return { pr: null, reason: "the work tree has no checked-out branch" };
    }
    if (runRepo === null) {
      return { pr: null, reason: `remote ${remote} names no GitHub repository` };
    }
    if (before.head !== head) {
      return { pr: null, reason: "the work tree head changed after the worker turn" };
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
    if (repoIdentity(entry.url, { pull: entry.number }) !== runRepo) {
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
    const refusal = confirm ? await confirm(entry.number) : null;
    const after = await readRunState(cwd, signal);
    if (after.branch !== branch || after.repo !== runRepo || after.head !== head) {
      return { pr: null, reason: "the branch, remote, or head changed during the PR read" };
    }
    if (refusal) return { pr: null, reason: refusal, trusted: true, undeclaredPr: entry.number };
    return { pr: entry.number };
  } catch (err) {
    return { pr: null, reason: `the PR read failed: ${readableErrorText(err)}` };
  }
}
