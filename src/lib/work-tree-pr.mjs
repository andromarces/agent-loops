// Reads the open pull request of the checked-out branch of a work tree for a worker envelope.
// A detached head, no match, several matches, a cross-repository match, or a failed read yields null.
import { repoSlug } from "./ci-required-sources.mjs";
import { readableErrorText } from "./error-message.mjs";
import { DEFAULT_READ_TIMEOUT_MS, boundedCall, ghFailureText, runGh } from "./gh-api.mjs";
import { gitRead } from "./git-read.mjs";
import { isJsonObject } from "./json.mjs";
import { logWarn } from "./log.mjs";
import { redactAndClean } from "./redact.mjs";

// Cap of the list read. A reply of this size holds too many PRs to name one, so it is ambiguous.
const LIST_LIMIT = 100;
const FIELDS = "number,headRefOid,isCrossRepository";
const FULL_SHA = /^[0-9a-fA-F]{40}$/;

// One entry of the `gh pr list` reply as the reader needs it. Any other shape is malformed.
const isEntry = (entry) =>
  isJsonObject(entry) &&
  Number.isSafeInteger(entry.number) &&
  entry.number > 0 &&
  typeof entry.headRefOid === "string" &&
  FULL_SHA.test(entry.headRefOid) &&
  typeof entry.isCrossRepository === "boolean";

function warnFailure(reason) {
  const line = redactAndClean(reason).replace(/\s+/g, " ").trim();
  logWarn(`worker: the work tree PR read failed: ${line}`);
}

/** Drops `GH_REPO`, so `gh` resolves the repository of the work tree and not another one. */
function withoutGhRepo(gh) {
  return (args, cwd, options = {}) =>
    gh(args, cwd, { ...options, dropEnv: [...(options.dropEnv ?? []), "GH_REPO"] });
}

/**
 * Reads the one open PR whose head branch is the checked-out branch of `cwd`. The `head` is the
 * one GitHub returned, so it can differ from the local work tree head, for example before a push.
 * A detached head returns null with no read. Every other failure warns once. A cancel returns
 * null with no warn, so the dispatch decides the turn outcome. No failure throws.
 * @param {{ cwd: string, gh?: Function, signal?: AbortSignal | null, timeoutMs?: number,
 *   git?: Function }} options
 * @returns {Promise<{ number: number, head: string } | null>}
 */
export async function readWorkTreePr({
  cwd,
  gh = runGh,
  signal = null,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  git = gitRead,
}) {
  if (signal?.aborted) return null;
  let branch;
  try {
    const result = await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { signal });
    if (signal?.aborted) return null;
    if (result.exitCode !== 0) return null;
    branch = result.stdout.trim();
  } catch (err) {
    if (signal?.aborted || err?.isCanceled) return null;
    warnFailure(readableErrorText(err));
    return null;
  }
  if (branch === "") return null;
  try {
    const call = boundedCall(withoutGhRepo(gh), timeoutMs, signal);
    // The slug read names the work tree repository, and the list read is pinned to it.
    const slug = await repoSlug(call, cwd);
    if (signal?.aborted) return null;
    const reply = await call(
      [
        "pr",
        "list",
        "--repo",
        slug,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        FIELDS,
        "--limit",
        String(LIST_LIMIT),
      ],
      cwd,
    );
    if (signal?.aborted) return null;
    if (!reply || reply.status !== 0) {
      warnFailure(
        `gh pr list failed: ${ghFailureText({
          status: reply?.status ?? "unknown",
          stderr: reply?.stderr ?? "",
        })}`,
      );
      return null;
    }
    const list = JSON.parse(reply.stdout);
    if (!Array.isArray(list) || list.length >= LIST_LIMIT || !list.every(isEntry)) {
      warnFailure("the gh pr list reply is not a list that names one PR");
      return null;
    }
    const sameRepo = list.filter((entry) => !entry.isCrossRepository);
    if (sameRepo.length !== 1) return null;
    const [entry] = sameRepo;
    return { number: entry.number, head: entry.headRefOid.toLowerCase() };
  } catch (err) {
    if (signal?.aborted || err?.isCanceled) return null;
    warnFailure(readableErrorText(err));
    return null;
  }
}
