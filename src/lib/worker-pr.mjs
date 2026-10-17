// Resolves the pull request that a worker turn opened, from Git and GitHub state only (ADR 0043).
// The runtime calls it after a worker turn of a headless run that has no PR input. No child turn
// names or changes the result.
import { readableErrorText } from "./error-message.mjs";
import { DEFAULT_READ_TIMEOUT_MS } from "./ci-gate.mjs";
import { ghFailureText, runGh } from "./ci-required-sources.mjs";
import { isJsonObject } from "./json.mjs";
import { gitRead } from "./snapshot.mjs";

// Cap of the list read. A reply of this size holds too many PRs to name one, so it is ambiguous.
const LIST_LIMIT = 100;

/**
 * Finds the one open, same-repository PR whose head branch is the checked-out branch of `cwd` and
 * whose head commit is `head`, the work tree head the runtime read after the worker turn.
 * Every other state leaves the run undeclared: a detached or unreadable branch, a failed or
 * unparseable `gh` read, no match, several matches, a PR from a fork, or a PR head that differs
 * from `head`. The function never throws.
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
    const { status, stdout, stderr } = await gh(
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,headRefName,headRefOid,isCrossRepository",
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
    if (!Array.isArray(list) || list.length >= LIST_LIMIT || !list.every(isJsonObject)) {
      return { pr: null, reason: "the gh pr list reply is not a list that names one PR" };
    }
    const sameRepo = list.filter(
      (entry) => entry.headRefName === branch && entry.isCrossRepository === false,
    );
    if (sameRepo.length === 0) {
      return { pr: null, reason: `no open PR from branch ${branch}`, quiet: true };
    }
    if (sameRepo.length > 1) {
      return { pr: null, reason: `${sameRepo.length} open PRs come from branch ${branch}` };
    }
    const [entry] = sameRepo;
    if (entry.headRefOid !== head) {
      return {
        pr: null,
        reason: `PR ${entry.number} head differs from the work tree head ${head}`,
      };
    }
    if (!Number.isSafeInteger(entry.number) || entry.number <= 0) {
      return { pr: null, reason: "the gh pr list reply has no valid PR number" };
    }
    return { pr: entry.number };
  } catch (err) {
    return { pr: null, reason: `the PR read failed: ${readableErrorText(err)}` };
  }
}
