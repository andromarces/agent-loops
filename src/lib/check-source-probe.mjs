// The probe of the `--all` check wait that decides whether any source can report a check for a PR
// head. It reads only, through the bounded `gh` runner of the wait (#1054).
import { commitEntries } from "./ci-gate.mjs";
import { ghApi, pagedRead, readOne } from "./ci-required-sources.mjs";
import { isJsonObject } from "./json.mjs";
import { prEventsFilteredOut, prWorkflowMayRun, UNREADABLE_TEXT } from "./workflow-paths.mjs";

// The workflow triggers that can run for a PR head, and the directory that holds the workflows. The
// probe scans the text of each workflow file for a trigger name instead of parsing the YAML, so a name
// in a comment or a step also keeps the wait. That errs toward the wait, never toward a skip.
const PR_TRIGGERS =
  /\b(?:pull_request|pull_request_target|push|merge_group|workflow_run|check_suite)\b/;
const WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_PATH = /^\.github\/workflows\//i;
// A base64 string as the contents API sends it, line breaks removed.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// The most items that the files endpoint of a PR (3,000) and the contents endpoint of a directory
// (1,000) return, so a list of that length may be cut and proves nothing.
const PR_FILES_CAP = 3000;
const DIRECTORY_CAP = 1000;

/**
 * The merge time of a `pulls` entry in ms: false for a PR that is not merged (`null`), null for any
 * value that is not a real UTC timestamp as the API writes it (`YYYY-MM-DDTHH:MM:SSZ`).
 */
function mergeTimeOf(value) {
  if (value === null) {
    return false;
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) || `${new Date(time).toISOString().slice(0, 19)}Z` !== value
    ? null
    : time;
}

/**
 * Whether `name` is a valid Git branch name, as `git check-ref-format --branch` judges it: no control
 * character, space, or one of `~^:?*[\`, no `..` or `@{`, no leading dash, no leading or trailing
 * slash or empty component, no component that starts with a dot or ends with `.lock`, no trailing dot,
 * and neither `@` nor `HEAD` alone. A name that fails is an unknown shape, never another branch.
 */
function isBranchName(name) {
  return (
    typeof name === "string" &&
    name !== "" &&
    name !== "@" &&
    name !== "HEAD" &&
    !name.startsWith("-") &&
    !name.endsWith(".") &&
    ![...name].some((char) => char <= " " || char === "\x7f" || "~^:?*[\\".includes(char)) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

// A full object name, so two heads compare by equality. `gh` reports SHA-1 and SHA-256 names.
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `value` is a full commit SHA, the form a `--head` and a read head carry. */
export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * The text of a workflow file from its contents reply, or null when the reply is not valid evidence:
 * a file at `path` with base64 content whose string is well formed, whose decoded length equals
 * `size`, and whose bytes are valid UTF-8. An empty file with `size` 0 is valid.
 */
function workflowText(body, path) {
  if (
    body.type !== "file" ||
    body.encoding !== "base64" ||
    typeof body.content !== "string" ||
    !Number.isInteger(body.size) ||
    body.size < 0 ||
    (body.path !== undefined && body.path !== path)
  ) {
    return null;
  }
  const encoded = body.content.replace(/\r?\n/g, "");
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== body.size) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The head SHAs of the PRs merged into `base` that hold the commit `baseSha` and share the latest
 * merge time, so a tie never resolves by list order. The list is empty when no such PR exists, and
 * null for a read that fails or any entry of another shape: a field must be exactly as the API
 * states it, a timestamp that is a real UTC date, a non-empty base ref, a lowercase full SHA. A PR
 * that is not merged, or merged into another branch, is no evidence.
 */
async function mergedHeadsOf({ bounded, slug, cwd }, baseSha, base) {
  const pages = await ghApi(
    pagedRead(bounded, null),
    [`repos/${slug}/commits/${baseSha}/pulls`],
    cwd,
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    return null;
  }
  let latest = -Infinity;
  let heads = [];
  for (const entry of pages.flat()) {
    const mergedAt = isJsonObject(entry) ? mergeTimeOf(entry.merged_at) : null;
    if (
      mergedAt === null ||
      !isJsonObject(entry.base) ||
      !isBranchName(entry.base.ref) ||
      !isJsonObject(entry.head) ||
      typeof entry.head.sha !== "string" ||
      !isFullSha(entry.head.sha)
    ) {
      return null;
    }
    if (mergedAt === false || entry.base.ref !== base || mergedAt < latest) {
      continue;
    }
    if (mergedAt > latest) {
      latest = mergedAt;
      heads = [];
    }
    heads.push(entry.head.sha);
  }
  return heads;
}

/** The lowercase full SHA of the head of `base`, or null for a read that fails or names none. */
async function baseShaOf({ bounded, slug, cwd }, base) {
  const read = await readOne(bounded, `repos/${slug}/commits/${encodeURIComponent(base)}`, cwd);
  const parsed = read.status === 0 ? JSON.parse(read.stdout) : null;
  const found = isJsonObject(parsed) && typeof parsed.sha === "string" ? parsed.sha : "";
  return isFullSha(found.toLowerCase()) ? found.toLowerCase() : null;
}

/** Whether a commit read shows no check run and no commit status. */
const hasNoEntries = ({ runs, statuses }) => runs.length === 0 && statuses.length === 0;

/** The paths of the PR files, a renamed-from path included. */
const changedPathsOf = (changed) =>
  changed.flatMap((file) =>
    file.previous_filename == null ? [file.filename] : [file.filename, file.previous_filename],
  );

/**
 * The file entries of the PR, or null for a read that fails, a list at the API cap, or an entry of
 * another shape.
 */
async function changedFilesOf({ bounded, slug, cwd, pr }) {
  const pages = await ghApi(pagedRead(bounded, null), [`repos/${slug}/pulls/${pr}/files`], cwd);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    return null;
  }
  const changed = pages.flat();
  if (changed.length >= PR_FILES_CAP) {
    return null;
  }
  return changed.every((file) => isJsonObject(file) && typeof file.filename === "string")
    ? changed
    : null;
}

/**
 * The texts of the workflow files at `baseSha`, or null for a read that fails, a listing at the API
 * cap, or an entry or file of another shape. A missing workflow directory holds no file.
 */
async function workflowTextsOf({ bounded, slug, cwd }, baseSha) {
  const listing = await readOne(
    bounded,
    `repos/${slug}/contents/${WORKFLOW_DIR}?ref=${baseSha}`,
    cwd,
  );
  let entries = [];
  if (listing.status !== 0) {
    if (!listing.notFound) {
      return null;
    }
  } else {
    entries = JSON.parse(listing.stdout);
    if (!Array.isArray(entries) || entries.length >= DIRECTORY_CAP) {
      return null;
    }
  }
  const texts = [];
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.path !== "string" || !WORKFLOW_PATH.test(entry.path)) {
      return null;
    }
    if (entry.type === "dir") {
      continue;
    }
    if (entry.type !== "file") {
      return null;
    }
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    const read = await readOne(bounded, `repos/${slug}/contents/${path}?ref=${baseSha}`, cwd);
    const body = read.status === 0 ? JSON.parse(read.stdout) : null;
    const text = isJsonObject(body) ? workflowText(body, entry.path) : null;
    if (text === null) {
      return null;
    }
    texts.push(text);
  }
  return texts;
}

/**
 * Whether no source can report a check for the PR head `sha`, once its own check runs and commit
 * statuses came back empty: the PR changes no file under `.github/workflows/`, no workflow of the
 * base branch names a trigger that can run for the PR head, and the base head shows no check run
 * and no commit status from any source, so a GitHub App or third-party CI with no workflow file is
 * covered too. The base branch resolves to one SHA first, and every base read uses it, so the
 * evidence comes from one commit. Each read is bounded by the wait, and a reply is validated before
 * it counts as evidence. A read that fails, cannot be parsed, is not exactly the expected shape, or
 * may be cut by an API cap returns false or throws, and the caller then keeps the normal wait. A
 * base branch or PR head that moved during the reads keeps it too. The head of the latest PR merged
 * as the base head commit is read for checks as well (#1062). Its limit: only those two commits are
 * read, so a provider that skipped both, or registers later, stays unseen (#1054).
 * @param {{ bounded: Function, slug: string, cwd: string, pr: number, headOf: () => Promise<{ head: string, base: string }> }} context
 *   `bounded` is the bounded `gh` runner of the wait, and `headOf` reads the PR head again.
 * @param {string} sha the PR head the wait reads
 * @param {string} base the base branch of the PR
 * @returns {Promise<boolean>}
 */
export async function noCheckSource(context, sha, base) {
  const { bounded, slug, cwd, headOf } = context;
  const baseSha = await baseShaOf(context, base);
  if (baseSha === null) {
    return false;
  }
  const changed = await changedFilesOf(context);
  if (changed === null) {
    return false;
  }
  for (const file of changed) {
    if (WORKFLOW_PATH.test(file.filename) || WORKFLOW_PATH.test(file.previous_filename ?? "")) {
      return false;
    }
  }
  const changedPaths = changedPathsOf(changed);
  const texts = await workflowTextsOf(context, baseSha);
  if (texts === null) {
    return false;
  }
  for (const text of texts) {
    if (UNREADABLE_TEXT.test(text)) {
      return false;
    }
    // A file that names a trigger keeps the wait unless every trigger is a PR event whose `paths`
    // filter matches no PR file (#1065).
    if (PR_TRIGGERS.test(text) && !prEventsFilteredOut(text, changedPaths)) {
      return false;
    }
  }
  if (!hasNoEntries(await commitEntries(bounded, slug, baseSha, cwd, true))) {
    return false;
  }
  // A provider that reports on PR heads only never shows on the base head, so the heads of the
  // latest merged PRs of that commit are read the same way (#1062).
  const mergedHeads = await mergedHeadsOf(context, baseSha, base);
  if (mergedHeads === null) {
    return false;
  }
  for (const mergedHead of mergedHeads) {
    if (!hasNoEntries(await commitEntries(bounded, slug, mergedHead, cwd, true))) {
      return false;
    }
  }
  // Neither the base branch nor the PR head moved while the probe read.
  const moved = await headOf();
  return moved.head === sha && moved.base === base && (await baseShaOf(context, base)) === baseSha;
}

/**
 * Whether a workflow file of `base` may run for the PR, so the wait holds a pass for a GitHub Actions
 * check run (#1228). The base branch resolves to one SHA, the files of the PR and the workflow files
 * at that SHA are read as `noCheckSource` reads them, and `prWorkflowMayRun` judges each file. A PR
 * that changes a workflow file may run it, whatever the base files say. False means every workflow
 * text proves that no run starts for the PR. Null means a read failed or has another shape, which is
 * unresolved: the caller holds the pass and reads again on its next poll. A throw is unresolved too.
 * @param {{ bounded: Function, slug: string, cwd: string, pr: number }} context the bounded `gh` runner of the wait
 * @param {string} base the base branch of the PR
 * @returns {Promise<boolean | null>}
 */
export async function pullRequestWorkflowMayRun(context, base) {
  const baseSha = await baseShaOf(context, base);
  const changed = baseSha === null ? null : await changedFilesOf(context);
  if (changed === null) {
    return null;
  }
  const changesWorkflow = changed.some(
    (file) => WORKFLOW_PATH.test(file.filename) || WORKFLOW_PATH.test(file.previous_filename ?? ""),
  );
  if (changesWorkflow) {
    return true;
  }
  const texts = await workflowTextsOf(context, baseSha);
  const paths = changedPathsOf(changed);
  return texts === null ? null : texts.some((text) => prWorkflowMayRun(text, paths, base));
}
