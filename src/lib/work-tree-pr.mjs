// Reads the open pull request of the checked-out branch of a work tree for a worker envelope.
// A detached head, no match, several matches, a cross-repository match, or a failed read yields null.
import { repoSlug } from "./checks/ci-required-sources.mjs";
import { oneLine, readableErrorText } from "./error-message.mjs";
import {
  DEFAULT_READ_TIMEOUT_MS,
  isPrListEntry,
  readOpenBranchPrs,
  runGh,
} from "./checks/gh-api.mjs";
import { boundedCall } from "./checks/bounded-call.mjs";
import { gitRead, readHeadBranch } from "./git-read.mjs";
import { isFullSha } from "./git-sha.mjs";
import { logWarn } from "./log.mjs";
import { redactAndClean } from "./redact.mjs";

const FIELDS = "number,headRefOid,isCrossRepository";

// One entry of the `gh pr list` reply as the reader needs it. Any other shape is malformed.
const isEntry = (entry) => isPrListEntry(entry) && isFullSha(entry.headRefOid.toLowerCase());

function warnFailure(reason) {
  const line = oneLine(redactAndClean(reason));
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
    branch = await readHeadBranch(git, cwd, { signal });
    if (signal?.aborted) return null;
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
    const read = await readOpenBranchPrs({
      branch,
      read: (args) => call(args, cwd),
      repo: slug,
      fields: FIELDS,
      isEntry,
    });
    if (signal?.aborted) return null;
    if (read.failure) {
      warnFailure(read.failure);
      return null;
    }
    if (read.list.length !== 1) return null;
    const [entry] = read.list;
    return { number: entry.number, head: entry.headRefOid.toLowerCase() };
  } catch (err) {
    if (signal?.aborted || err?.isCanceled) return null;
    warnFailure(readableErrorText(err));
    return null;
  }
}
