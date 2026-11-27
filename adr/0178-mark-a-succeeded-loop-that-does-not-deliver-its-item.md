# 0178. Mark a succeeded loop that does not deliver its item

## Status

accepted

## Date

2026-11-28

## Context

A batch loop ends `succeeded` when its headless run exits 0, whatever its finish summary says
([ADR 0115](0115-batch-loop-final-report.md)). The owner reads the loop status and
`completion.complete` first, so a loop that reports the item not done still reads as a delivered
item unless the owner opens `report.summary.notDone` for every loop.

A 6-issue `work-first` batch on 2026-11-27 ended with all six loops `succeeded` and
`completion: { status: "completed", complete: true }`. In one loop the worker found no safe fix and
opened a pull request with `Refs #N` instead of `Closes #N`. The reviewer accepted that pull
request. Its `report.summary.notDone` said the issue is not fixed, and its `open` named a
maintainer decision, yet nothing in the loop status, the batch status, or the completion block set
it apart from the five loops that closed their issues
([issue #2049](https://github.com/andromarces/agent-loops/issues/2049)).

The batch already reads closing references before each launch
([ADR 0106](0106-foreground-batch-scheduling.md) decision 6), but it records no per-loop delivery
fact. The overlap report ([ADR 0176](0176-report-batch-pull-requests-that-change-the-same-files.md))
covers a different question: which pull requests need combined validation.

## Decision

1. A `succeeded` loop entry in the `start` and `resume` summary and in `batch status` holds
   `partial: true` and a `partialReasons` list when its delivery is incomplete. Every other loop
   omits both fields, so a batch whose loops are all fully delivered shows no marker.
2. The reasons are `not-done` and `pull-request-does-not-close-issue`. `not-done` applies when the
   stored finish summary holds a `notDone` that is neither blank nor `none`, compared
   case-insensitively after trimming. `pull-request-does-not-close-issue` applies to a loop whose
   pull request does not name its issue in the closing references that GitHub computes.
3. The not-done fact is derived at read time from the stored report. A checkpoint written before
   this change, and a resume of a batch that had already ended, report it with no new read and no
   new write.
4. The closing fact is read once when the loop succeeds, for an issue item with a pull request
   number. The pull request is the declared one, else the undeclared one, the same order that the
   merged proof and `batch status` use ([ADR 0131](0131-name-the-undeclared-pull-request-of-a-batch-loop.md)).
   The read is `gh pr view <n> --json closingIssuesReferences`, the same closing-reference source
   that the eligibility check reads. The success checkpoint records the fact in the same write as
   its status and report, so the marker never depends on a later read.
5. A failed or unreadable closing read, including a reply with no reference list, logs one warning
   and records no fact. It never marks a loop, never fails the batch, and never changes an exit
   code. A loop without a pull request number makes no read.
6. `batch status` reports `completion.complete: false` while any loop entry is partial. The
   completion block keeps the stored batch status, so a partial delivery never reads as fully
   delivered and the batch status itself stays as it was.
7. The loop stays terminal `succeeded`. The marker adds no retry, no failure, no `needs-owner`
   decision, no claim, work-tree, or branch change, and no exit-code change.

## Consequences

- The owner sees a partial delivery in the loop entry and in the completion flag, without opening
  each loop's report.
- A loop whose finish summary reports work not done is named even when its pull request closes the
  issue, and a loop whose pull request does not close its issue is named even when its summary
  reports `notDone: none`.
- A completed batch makes at most one closing-reference read per succeeded issue pull request.
  A transient GitHub failure costs one warning and one missing marker, and it is not reported as a
  delivery.
- An old checkpoint reports the not-done reason from its stored report, and reports no closing
  reason until a loop succeeds again.

## Alternatives

1. **List the partial loops only in the completion block.** Rejected. The loop entry is where the
   owner reads the status, so the reason belongs beside it, and the completion flag alone names no
   loop.
2. **Turn a partial loop into `failed` or `needs-owner`.** Rejected by issue #2049. The run
   finished and its pull request exists; the batch reports the gap and does not retry it.
3. **Mark a loop by the open state of its issue.** Rejected. A pull request is normally unmerged
   when its loop ends, so an open issue names no gap. The closing reference is the fact that the
   pull request will close the issue on merge, or will not.
4. **Fail the report closed on a failed closing read.** Rejected. The loops already succeeded, and a
   monitoring read failure is no loop failure; a warning names the missing fact.
5. **Read the closing references again in `batch status`.** Rejected. That command writes nothing
   and reads no network today, and the success checkpoint holds the fact.
6. **Derive the closing fact from the loop report only.** Rejected. The finish summary has no
   closing reference, and the observed loop reported both a `notDone` and a non-closing pull
   request, which are separate facts.

## Links

- [Issue #2049: Mark a succeeded batch loop whose finish summary reports the item not done](https://github.com/andromarces/agent-loops/issues/2049)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0115: Report each loop's final report in the batch summary](0115-batch-loop-final-report.md)
- [ADR 0131: Name the undeclared pull request of a batch loop](0131-name-the-undeclared-pull-request-of-a-batch-loop.md)
- [ADR 0176: Report batch pull requests that change the same files](0176-report-batch-pull-requests-that-change-the-same-files.md)
- [Implementation: loop entry and partial reasons](../src/batch/loop-records.mjs)
- [Implementation: loop success](../src/batch/supervisor.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Tests: batch outcomes](../tests/batch/supervisor.outcomes.test.mjs)
- [ADR Index](README.md)
