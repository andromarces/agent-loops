// The changed-file overlap of a finished batch (adr/0176-report-batch-pull-requests-that-change-the-same-files.md).
// It only reports the groups: the batch never merges, combines, or tests the pull requests.
import { logWarn } from "../lib/log.mjs";
import { mapInBatches } from "../lib/map-in-batches.mjs";
import { readGhJson } from "./gh-read.mjs";

const READ_BATCH_SIZE = 4;

/** The changed paths of one pull request, or null for a reply that names no file list of paths. */
async function changedPathsOf(gh, repo, pr) {
  const view = await readGhJson(gh, ["pr", "view", String(pr), "--json", "files"], repo);
  if (!Array.isArray(view?.files)) return null;
  const paths = [];
  for (const file of view.files) {
    if (typeof file?.path !== "string") return null;
    paths.push(file.path);
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
 * Reads the changed-file lists of the pull requests of the succeeded loops and returns each group
 * that shares at least one path. `loops` holds loop records, and a loop without a succeeded status
 * or an integer pull request number is not read. A failed or malformed read logs one warning
 * through `warn` and leaves out only that pull request.
 * @param {{ loops: Array<object>, gh: Function, repo: string, warn?: (message: string) => void }} options
 * @returns {Promise<Array<{ pulls: number[], paths: string[] }>>}
 */
export async function overlapGroupsOf({ loops, gh, repo, warn = logWarn }) {
  const numbers = [
    ...new Set(
      loops
        .filter((loop) => loop.status === "succeeded" && Number.isInteger(loop.pr))
        .map((loop) => loop.pr),
    ),
  ].sort((a, b) => a - b);
  // One pull request cannot overlap, and a failed read cannot make a group visible.
  if (numbers.length < 2) return [];
  const reads = await mapInBatches(numbers, READ_BATCH_SIZE, async (pr) => {
    let paths;
    try {
      paths = await changedPathsOf(gh, repo, pr);
    } catch (err) {
      warn(`pull request ${pr}: the file list read failed: ${err?.message ?? err}`);
      return null;
    }
    if (paths === null) {
      warn(`pull request ${pr}: the file list read named no readable file list`);
      return null;
    }
    return paths;
  });
  const entries = [];
  for (let index = 0; index < numbers.length; index += 1) {
    const paths = reads[index];
    if (paths === null) continue;
    entries.push({ pr: numbers[index], paths, set: new Set(paths) });
  }
  return groupEntries(entries);
}
