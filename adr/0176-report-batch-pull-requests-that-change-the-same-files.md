# 0176. Report batch pull requests that change the same files

## Status

accepted

## Date

2026-11-27

## Context

A batch runs related issues concurrently, and each loop validates only its own pull request. The
batch summary does not say which pull requests change the same files.

A 3-issue `work-first` batch on 2026-11-27 ended with every loop `succeeded`. Each reviewer
accepted its own head, and CI passed on all three pull requests. Two of the three changed the same
handler module. One replaced an import that the other still called, and a merge of all three
branches failed 8 tests. Nothing in the summary or in `batch status` pointed to the overlap
([issue #2044](https://github.com/andromarces/agent-loops/issues/2044)).

The batch summary reports one loop entry per item ([ADR 0115](0115-batch-loop-final-report.md)), and
no field compares two loop pull requests. The `gh pr view --json files` reply stops at 100 files,
and a pull request can change more, so a single reply cannot prove a complete list.

## Decision

1. When a batch reaches `completed` or `failed`, it compares the changed-file lists of the pull
   requests of its succeeded loops. A loop without a succeeded status or without an integer pull
   request number is not read.
2. The changed files of one pull request come from the paginated REST file list,
   `repos/{owner}/{repo}/pulls/<n>/files`, read through the shared paged reader. The list must
   hold exactly the changed-file count of that pull request, read from
   `gh pr view <n> --json changedFiles`. At most four pull requests are read at once, through the
   existing batched map helper.
3. The list is incomplete when a read fails, its length differs from the changed-file count, it
   reaches the 3000-file API cap, or an entry names no path. The 3000-file cap is the API limit, so
   a list at the cap cannot prove that no file is missing.
4. Each group holds the pull requests that share at least one path, in `pulls`, and the paths that
   at least two members change, in `paths`. A chain of shared paths, such as one pull request that
   shares a path with each of two others, joins one group.
5. A batch with no shared path holds an empty `overlapGroups` list, so an absent overlap never
   reads as one. A pull request outside every group is not named. `overlapIncomplete` holds the
   numbers of the pull requests whose list the read cannot prove complete, and it is empty when
   every list is complete. A pull request named there is left out of the groups, so its absence
   never reads as no overlap.
6. The manifest records the groups in `overlapGroups` and the unprovable lists in
   `overlapIncomplete`. The `start` and `resume` summary and `batch status` print those stored
   fields, and `batch status` reads no pull request again.
7. A failed or incomplete file-list read logs one warning that names the pull request and leaves
   out only that pull request. It never fails the batch, never changes another loop status, and
   never changes the exit code.
8. The overlaps are read before the batch is recorded `completed` or `failed`. A stop during the
   read keeps the interrupted result: the batch records `interrupted`, sends no completion
   notification, exits 130, and stores no overlap. The next `batch resume` computes the report.
9. A resume of a batch that was already `completed` or `failed` when it started keeps the stored
   fields and reads no pull request. A write happens only when a stored field changes.
10. The report changes no other batch behavior. The completion write, the completion notification,
    and the exit codes stay as they were. The batch never merges, combines, or tests the pull
    requests, and it changes no branch, work tree, claim, or pull request.

## Consequences

- The owner sees which pull requests need combined validation before merging, in the summary and in
  `batch status`.
- A pull request with more than 100 changed files still reports an overlap that sits on a later
  page, and a list the read cannot prove complete is named in `overlapIncomplete` instead of
  reading as no overlap.
- An unreadable or truncated file list costs one warning and removes one pull request from the
  groups, so a GitHub read failure cannot fail work that already succeeded.
- A completed batch makes at most one changed-file count read and one paged file-list read per
  succeeded pull request, and a resume of an ended batch makes none.
- A stop during the overlap read ends the batch as interrupted, and the resume reports the overlap,
  so no completed batch lacks its report.
- The groups are a report only, so no merge, test, or branch state depends on them.

## Alternatives

1. **Change each loop entry with its overlapping pull requests.** Rejected. The overlap is a
   property of a pair or group, not of one loop, and a two-sided field duplicates the data.
2. **Group by each common path separately.** Rejected. One pair that shares three paths would
   report three groups, and a chain of shared paths would read as unrelated pairs.
3. **Keep the single `gh pr view --json files` reply.** Rejected. It stops at 100 files, so a
   shared path on a later page would read as no overlap.
4. **Fail the batch on a failed file-list read.** Rejected. Issue #2044 requires a warning only: the
   loops already succeeded, and a read failure is no loop failure.
5. **Read the files at each loop end.** Rejected. A later loop can change the same file, so only the
   end of the batch holds the final set of pull requests.
6. **Read the overlaps after the completion write.** Rejected. A stop during the read then leaves a
   completed batch with no report, and the resume takes the completed batch as a no-op.
7. **Merge, test, or combine the pull requests.** Rejected by issue #2044. The batch only reports.

## Links

- [Issue #2044: Report batch pull requests that change the same files](https://github.com/andromarces/agent-loops/issues/2044)
- [PR #2045: Report batch pull requests that change the same files](https://github.com/andromarces/agent-loops/pull/2045)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0115: Report each loop's final report in the batch summary](0115-batch-loop-final-report.md)
- [Implementation: changed-file groups](../src/batch/overlap.mjs)
- [Implementation: batch finalization](../src/batch/supervisor.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Tests: changed-file groups](../tests/batch/overlap.test.mjs)
- [Tests: batch outcomes](../tests/batch/supervisor.outcomes.test.mjs)
- [ADR Index](README.md)
