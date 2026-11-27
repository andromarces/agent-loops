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
no field compares two loop pull requests.

## Decision

1. When a batch reaches `completed` or `failed`, it compares the changed-file lists of the pull
   requests of its succeeded loops. A loop without a succeeded status or without an integer pull
   request number is not read.
2. The changed files of one pull request come from one `gh pr view <n> --json files` read. At most
   four such reads run at once, through the existing batched map helper.
3. Each group holds the pull requests that share at least one path, in `pulls`, and the paths that
   at least two members change, in `paths`. A chain of shared paths, such as one pull request that
   shares a path with each of two others, joins one group.
4. A batch with no shared path holds an empty list, so an absent overlap never reads as one. A
   pull request outside every group is not named.
5. The manifest records the groups in `overlapGroups`. The `start` and `resume` summary and
   `batch status` print that stored field, and `batch status` reads no pull request again.
6. A failed or malformed file-list read logs one warning that names the pull request and leaves out
   only that pull request. It never fails the batch, never changes another loop status, and never
   changes the exit code.
7. A resume of a batch that was already `completed` or `failed` when it started keeps the stored
   groups and reads no pull request. A write happens only when the stored groups change.
8. The report changes no other batch behavior. The batch never merges, combines, or tests the pull
   requests, and it changes no branch, work tree, claim, or pull request.

## Consequences

- The owner sees which pull requests need combined validation before merging, in the summary and in
  `batch status`.
- An unreadable file list costs one warning and removes one pull request from the report, so a
  GitHub read failure cannot fail work that already succeeded.
- A completed batch makes at most one read per succeeded pull request, and a resume of an ended
  batch makes none.
- The groups are a report only, so no merge, test, or branch state depends on them.

## Alternatives

1. **Change each loop entry with its overlapping pull requests.** Rejected. The overlap is a
   property of a pair or group, not of one loop, and a two-sided field duplicates the data.
2. **Group by each common path separately.** Rejected. One pair that shares three paths would
   report three groups, and a chain of shared paths would read as unrelated pairs.
3. **Fail the batch on a failed file-list read.** Rejected. Issue #2044 requires a warning only: the
   loops already succeeded, and a read failure is no loop failure.
4. **Read the files at each loop end.** Rejected. A later loop can change the same file, so only the
   end of the batch holds the final set of pull requests.
5. **Merge, test, or combine the pull requests.** Rejected by issue #2044. The batch only reports.

## Links

- [Issue #2044: Report batch pull requests that change the same files](https://github.com/andromarces/agent-loops/issues/2044)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0115: Report each loop's final report in the batch summary](0115-batch-loop-final-report.md)
- Implementation: changed-file groups in `src/batch/overlap.mjs`
- Implementation: finalization in `src/batch/supervisor.mjs`
- Implementation: status read in `src/batch/status.mjs`
- Tests: `tests/batch/overlap.test.mjs` and `tests/batch/supervisor.outcomes.test.mjs`
- [ADR Index](README.md)
