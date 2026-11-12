// Resolves the pull request that a worker turn opened, from Git and GitHub state only (ADR 0043).
// The runtime calls it after a worker turn of a headless run that has no PR input. No child turn
// names or changes the result.
import { readableErrorText } from "./error-message.mjs";
import {
  DEFAULT_READ_TIMEOUT_MS,
  isPrListEntry,
  readOpenBranchPrs,
  runGh,
} from "./checks/gh-api.mjs";
import { execBounded } from "./exec.mjs";
import { gitRead, readHeadBranch } from "./git-read.mjs";

const SCP_REMOTE = /^([^@\s/]+)@([^:\s/]+):([^/\s]+)\/([^/\s]+)$/;

/**
 * Runs `ssh -G` under the caller's bound. A non-zero exit, a timeout, or a cancel is data, not a
 * throw.
 */
async function runSsh(args, cwd, { timeoutMs = 0, signal = null } = {}) {
  const result = await execBounded("ssh", args, { cwd, timeoutMs, signal });
  return {
    status: result.exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: Boolean(result.timedOut),
  };
}

/**
 * The canonical host that the SSH configuration gives for `host` with `user`, or null. `ssh -G`
 * contacts no host. An `ssh:` URL user is percent-decoded, and a malformed value gives null. A host
 * or user that starts with `-` never reaches the argument list. A failed, timed-out, canceled, or
 * hostless read gives null.
 */
async function resolvedSshHost(host, { user, decodeUser = false, ssh, cwd, signal, timeoutMs }) {
  let login = user;
  if (decodeUser && login) {
    try {
      login = decodeURIComponent(login);
    } catch {
      return null;
    }
  }
  if (host.startsWith("-") || (login && login.startsWith("-"))) return null;
  let result;
  try {
    result = await ssh(login ? ["-G", "-l", login, host] : ["-G", host], cwd, {
      signal,
      timeoutMs,
    });
  } catch {
    return null;
  }
  if (!result || result.status !== 0 || result.timedOut) return null;
  for (const line of String(result.stdout).split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key === "hostname" && value) return value;
  }
  return null;
}

/**
 * The lowercase `host/owner/repo` identity of a GitHub repository URL, or null. A remote takes the
 * `https`, `http`, `ssh`, and `git` URL forms and the scp form `git@host:owner/repo`. For the scp
 * and `ssh:` forms the host resolves through `ssh -G` with the remote user, and a failed read keeps
 * the literal host. An SSH host `ssh.github.com` maps to `github.com`. A PR URL (`pull`, the PR
 * number) takes the form `https://host/owner/repo/pull/<number>`, and its last segment must equal
 * that number.
 */
async function repoIdentity(text, { pull = null, ssh = runSsh, cwd, signal, timeoutMs } = {}) {
  const scp = pull === null ? SCP_REMOTE.exec(text) : null;
  let user;
  let host;
  let segments;
  let sshRemote = false;
  let decodeUser = false;
  if (scp) {
    [, user, host, ...segments] = scp;
    sshRemote = true;
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
    user = url.username;
    host = url.hostname;
    sshRemote = pull === null && url.protocol === "ssh:";
    decodeUser = sshRemote;
    segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== (pull !== null ? 4 : 2)) return null;
    if (pull !== null && (segments[2] !== "pull" || segments[3] !== String(pull))) return null;
    segments = segments.slice(0, 2);
  }
  const [owner, repo] = segments;
  const name = repo.replace(/\.git$/, "");
  const resolved =
    sshRemote && host
      ? ((await resolvedSshHost(host, { user, decodeUser, ssh, cwd, signal, timeoutMs })) ?? host)
      : host;
  const canonical =
    sshRemote && resolved && resolved.toLowerCase() === "ssh.github.com" ? "github.com" : resolved;
  return canonical && owner && name ? `${canonical}/${owner}/${name}`.toLowerCase() : null;
}

/**
 * Reads the Git state for the PR match: the branch, the branch remote, the remote repository
 * identity, and the work tree head. A field that cannot be read is null.
 * The resolver reads it before and after the `gh` read and compares the two. The remote host
 * resolves through `ssh`.
 */
async function readRunState(cwd, signal, { ssh = runSsh, timeoutMs } = {}) {
  // The head read does not depend on the branch chain, so it runs beside it. A failure of the chain
  // throws first, as in sequential reads, and the head read settles before the throw.
  const headRead = gitRead(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { signal });
  headRead.catch(() => {});
  try {
    const branch = await readHeadBranch(gitRead, cwd, { signal });
    if (branch === "") return { branch: null, remote: null, repo: null, head: null };
    const remoteRead = await gitRead(cwd, ["config", "--get", `branch.${branch}.remote`], {
      signal,
    });
    const configured = remoteRead.exitCode === 0 ? remoteRead.stdout.trim() : "";
    const remote = configured === "" || configured === "." ? "origin" : configured;
    const urlRead = await gitRead(cwd, ["remote", "get-url", remote], { signal });
    const repo =
      urlRead.exitCode === 0
        ? await repoIdentity(urlRead.stdout.trim(), { ssh, cwd, signal, timeoutMs })
        : null;
    const head = (await headRead).exitCode === 0 ? (await headRead).stdout.trim() : null;
    return { branch, remote, repo, head };
  } finally {
    await headRead.catch(() => {});
  }
}

// One entry of the `gh pr list` reply as the resolver reads it. Any other shape is malformed.
const isListEntry = (entry) =>
  isPrListEntry(entry) && typeof entry.headRefName === "string" && typeof entry.url === "string";

/**
 * Finds the one open PR of the checked-out branch whose head is `head`, the work tree head after
 * the worker turn. Its base repository must be the branch remote's repository, and the head,
 * branch, and remote must not change during the `gh` read.
 * The branch remote is `branch.<branch>.remote`, or `origin` when none is set. `GH_REPO` never
 * decides the check, because the PR URL host, owner, and repo must match the remote URL, and the
 * function never throws.
 * An SSH remote host, in the scp and `ssh:` forms, resolves through `ssh -G`, and a failed read
 * keeps the literal host.
 * A detached branch, an unreadable remote, a failed or malformed reply, no match, several matches,
 * or a moving head leaves the run undeclared.
 * @param {{ cwd: string, head: string | null, gh?: Function, ssh?: Function, signal?: AbortSignal, timeoutMs?: number, confirm?: (pr: number) => Promise<string | null> }} options
 * @returns {Promise<{ pr: number } | { pr: null, reason: string, quiet?: true, trusted?: true, undeclaredPr?: number }>}
 */
export async function resolveWorkerPr({
  cwd,
  head,
  gh = runGh,
  ssh = runSsh,
  signal,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  confirm = null,
}) {
  if (typeof head !== "string" || head === "" || head === "unborn") {
    return { pr: null, reason: "the work tree head is not known" };
  }
  try {
    const before = await readRunState(cwd, signal, { ssh, timeoutMs });
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
    const read = await readOpenBranchPrs({
      branch,
      read: (args) => gh(args, cwd, { signal, timeoutMs }),
      fields: "number,headRefName,headRefOid,isCrossRepository,url",
      isEntry: isListEntry,
    });
    if (read.failure) {
      return { pr: null, reason: read.failure };
    }
    const sameRepo = read.list.filter((entry) => entry.headRefName === branch);
    if (sameRepo.length === 0) {
      return { pr: null, reason: `no open PR from branch ${branch}`, quiet: true };
    }
    if (sameRepo.length > 1) {
      return { pr: null, reason: `${sameRepo.length} open PRs come from branch ${branch}` };
    }
    const [entry] = sameRepo;
    if ((await repoIdentity(entry.url, { pull: entry.number })) !== runRepo) {
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
    // `confirm` reads the matched PR before the final identity check. It returns null to accept, or
    // the runtime-owned reason that sets `trusted` and `undeclaredPr` for ADR 0052 (#1111).
    const refusal = confirm ? await confirm(entry.number) : null;
    const after = await readRunState(cwd, signal, { ssh, timeoutMs });
    if (after.branch !== branch || after.repo !== runRepo || after.head !== head) {
      return { pr: null, reason: "the branch, remote, or head changed during the PR read" };
    }
    if (refusal) return { pr: null, reason: refusal, trusted: true, undeclaredPr: entry.number };
    return { pr: entry.number };
  } catch (err) {
    return { pr: null, reason: `the PR read failed: ${readableErrorText(err)}` };
  }
}
