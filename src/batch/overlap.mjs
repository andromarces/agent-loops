// The changed-file overlap of a finished batch (adr/0176-report-batch-pull-requests-that-change-the-same-files.md).
// It only reports the groups: the batch never merges, combines, or tests the pull requests.
import { ghApi, pagedRead } from "../lib/checks/gh-api.mjs";
import { isJsonObject } from "../lib/json.mjs";
import { logWarn } from "../lib/log.mjs";
import { mapInBatches } from "../lib/map-in-batches.mjs";
import { readGhJson } from "./gh-read.mjs";

const READ_BATCH_SIZE = 4;
// The REST files list stops at 3000 files, so a list at the cap proves nothing.
const PR_FILES_CAP = 3000;
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** The `owner/name` of the repository, or null for a reply that names no readable value. */
async function repoSlugOf(gh, repo) {
  const view = await readGhJson(gh, ["repo", "view", "--json", "nameWithOwner"], repo);
  const slug = isJsonObject(view) ? view.nameWithOwner : null;
  return typeof slug === "string" && SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Every changed path of one pull request, read from the paginated REST file list and checked
 * against the changed-file count. Throws a message that names the missing proof: a failed read, a
 * list shorter or longer than the count, a list at the API cap, or an entry of another shape.
 */
async function completePathsOf(gh, repo, slug, pr) {
  const view = await readGhJson(gh, ["pr", "view", String(pr), "--json", "changedFiles"], repo);
  if (!isJsonObject(view) || !Number.isInteger(view.changedFiles) || view.changedFiles < 0) {
    throw new Error("the changed-file count is unreadable");
  }
  const pages = await ghApi(pagedRead(gh, null), [`repos/${slug}/pulls/${pr}/files`], repo);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("the read named no page list");
  }
  const entries = pages.flat();
  if (entries.length >= PR_FILES_CAP) {
    throw new Error(`the list reaches the ${PR_FILES_CAP}-file API cap`);
  }
  if (entries.length !== view.changedFiles) {
    throw new Error(
      `the list holds ${entries.length} file(s) for ${view.changedFiles} changed file(s)`,
    );
  }
  const paths = [];
  for (const entry of entries) {
    if (!isJsonObject(entry) || typeof entry.filename !== "string") {
      throw new Error("the list holds an entry that names no path");
    }
    paths.push(entry.filename);
    if (typeof entry.previous_filename === "string") paths.push(entry.previous_filename);
  }
  return paths;
}

/**
 * The groups of two or more pull requests that change at least one common path, with every path
 * changed by at least two members. A chain of shared paths joins one group. Each group is
 * `{ pulls, paths }`, both sorted.
 */
function groupEntries(entries) {
  const parent = new Map(entries.map(({ pr }) => [pr, pr]));
  const find = (pr) => {
    while (parent.get(pr) !== pr) pr = parent.get(pr);
    return pr;
  };
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const shares = entries[left].paths.some((path) => entries[right].set.has(path));
      if (shares) {
        const leftRoot = find(entries[left].pr);
        const rightRoot = find(entries[right].pr);
        if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
      }
    }
  }
  const members = new Map();
  for (const entry of entries) {
    const root = find(entry.pr);
    members.set(root, [...(members.get(root) ?? []), entry]);
  }
  const groups = [];
  for (const group of members.values()) {
    if (group.length < 2) continue;
    const counts = new Map();
    for (const entry of group) {
      for (const path of new Set(entry.paths)) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    const paths = [...counts]
      .filter(([, count]) => count > 1)
      .map(([path]) => path)
      .sort();
    groups.push({ pulls: group.map(({ pr }) => pr).sort((a, b) => a - b), paths });
  }
  return groups.sort((a, b) => a.pulls[0] - b.pulls[0]);
}

/**
 * Reads every changed-file list of the pull requests of the succeeded loops and returns the groups
 * that share at least one path, beside the pull requests whose list that read cannot prove
 * complete. `loops` holds loop records, and a loop without a succeeded status or an integer pull
 * request number is not read. A failed or incomplete read logs one warning through `warn` and
 * leaves out only that pull request.
 * @param {{ loops: Array<object>, gh: Function, repo: string, warn?: (message: string) => void }} options
 * @returns {Promise<{ groups: Array<{ pulls: number[], paths: string[] }>, incomplete: number[] }>}
 */
export async function overlapReportOf({ loops, gh, repo, warn = logWarn }) {
  const numbers = [
    ...new Set(
      loops
        .filter((loop) => loop.status === "succeeded" && Number.isInteger(loop.pr))
        .map((loop) => loop.pr),
    ),
  ].sort((a, b) => a - b);
  // One pull request cannot overlap, and no read is needed to report that.
  if (numbers.length < 2) return { groups: [], incomplete: [] };
  let slug;
  try {
    slug = await repoSlugOf(gh, repo);
  } catch (err) {
    warn(`the repository name read failed: ${err?.message ?? err}`);
    return { groups: [], incomplete: numbers };
  }
  if (slug === null) {
    warn("the repository name read named no readable owner and name");
    return { groups: [], incomplete: numbers };
  }
  const reads = await mapInBatches(numbers, READ_BATCH_SIZE, async (pr) => {
    try {
      return { pr, paths: await completePathsOf(gh, repo, slug, pr) };
    } catch (err) {
      warn(`pull request ${pr}: the file list read is incomplete: ${err?.message ?? err}`);
      return { pr, paths: null };
    }
  });
  const report = { groups: [], incomplete: [] };
  const entries = [];
  for (const { pr, paths } of reads) {
    if (paths === null) report.incomplete.push(pr);
    else entries.push({ pr, paths, set: new Set(paths) });
  }
  report.groups = groupEntries(entries);
  return report;
}
