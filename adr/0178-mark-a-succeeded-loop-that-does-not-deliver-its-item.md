# 0178. Mark a succeeded loop that does not deliver its item

## Status

accepted

## Date

2026-11-28

## Supersedes

This ADR partially supersedes
[ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md).
The replaced part is decision 8's rule that `complete` is true only for the statuses `completed`
and `failed`. `complete` is also false while a loop entry is partial. The rest of decision 8,
including the per-loop `decision`, `blockingIssues`, and `requiredMerges` fields and the
write-nothing rule of `batch status`, and every other decision of ADR 0110 stays in force.

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

The batch already reads closing evidence before each launch
([ADR 0106](0106-foreground-batch-scheduling.md) decision 6), but it records no per-loop delivery
fact. The overlap report ([ADR 0176](0176-report-batch-pull-requests-that-change-the-same-files.md))
covers a different question: which pull requests need combined validation.

## Decision

1. A `succeeded` loop entry in the `start` and `resume` summary and in `batch status` holds
   `partial: true` and a `partialReasons` list when its delivery is incomplete. Every other loop
   omits both fields, so a batch whose loops are all fully delivered shows no marker.
2. The `not-done` reason applies to any item whose stored finish summary holds a `notDone` that is
   neither blank nor `none`, compared case-insensitively after trimming.
3. An issue item also names its missing delivery evidence. `no-pull-request` applies when it
   records no pull request number. `pull-request-does-not-close-issue` applies when its pull
   request does not name its issue among the issues the pull request closes.
   `closing-reference-unread` applies when that evidence cannot be read. A pull request item and a
   task item name no delivery reason, because neither closes an issue.
4. The `not-done` fact is derived at read time from the stored report. A checkpoint written before
   this change, and a resume of a batch that had already ended, report it with no new read and no
   new write.
5. The closing evidence is read once when an issue loop succeeds, for the pull request of the
   final attempt only: the declared number, else the undeclared number. A value that an earlier
   attempt stored is no evidence. A loop record without a kind is an issue item, as the batch entry
   reads it.
6. The evidence is the same set that the eligibility check reads, through the shared helpers in
   `src/batch/eligibility.mjs`: the pull request's closing references, its body keywords when its
   base is not the default branch, and its commit messages. A closing reference counts only when
   its repository is the batch repository, compared by owner and name without case, so another
   repository's `#42` never closes local issue 42. One `gh pr view` read names the references,
   body, and base, and the paginated commit read names the commit messages. The repository identity
   is read once per command and shared by every delivery check. The success checkpoint records the
   fact in the same write as its status and report, so the marker never depends on a later read.
7. A failed call, a reply without a closing reference list, a closing reference whose repository
   identity is missing or unreadable, and a commit list that reaches the API's 250-commit page
   without naming the issue are all unreadable evidence. Each logs one warning and records
   `null`, which reads as `closing-reference-unread`. An unreadable read never reads as delivered,
   never fails the batch, and never changes an exit code. The eligibility check keeps excluding an
   issue whose closing reference names no readable repository, as it did before this ADR: only a
   readable reference to another repository stops counting as a closure.
8. `batch status` reports `completion.complete: false` while any loop entry is partial. The
   completion block keeps the stored batch status, so a partial delivery never reads as fully
   delivered and the batch status itself stays as it was. This replaces the `complete` rule of
   [ADR 0110](0110-release-batch-slots-on-owner-decisions.md) decision 8.
9. The loop stays terminal `succeeded`. The marker adds no retry, no failure, no `needs-owner`
   decision, no claim, work-tree, or branch change, and no exit-code change.

## Consequences

- The owner sees a partial delivery in the loop entry and in the completion flag, without opening
  each loop's report.
- An issue loop that succeeds with no pull request is named as partial, because it holds no
  delivery evidence.
- A closing reference to another repository, and a reference whose repository identity is
  unreadable, are never read as a closure of the local issue.
- A loop whose finish summary reports work not done is named even when its pull request closes the
  issue, and a loop whose pull request does not close its issue is named even when its summary
  reports `notDone: none`.
- A transient GitHub failure, a malformed reply, or an incomplete commit read costs one warning and
  a `closing-reference-unread` marker. The loop is never reported as delivered on unreadable
  evidence.
- A completed batch makes at most one repository identity read, one pull request read, and one
  paginated commit read per succeeded issue loop.
- An old checkpoint reports the not-done reason from its stored report, and reports
  `closing-reference-unread` until the loop succeeds again.

## Alternatives

1. **List the partial loops only in the completion block.** Rejected. The loop entry is where the
   owner reads the status, so the reason belongs beside it, and the completion flag alone names no
   loop.
2. **Turn a partial loop into `failed` or `needs-owner`.** Rejected by issue #2049. The run
   finished and its pull request exists; the batch reports the gap and does not retry it.
3. **Mark a loop by the open state of its issue.** Rejected. A pull request is normally unmerged
   when its loop ends, so an open issue names no gap. The closing reference is the fact that the
   pull request will close the issue on merge, or will not.
4. **Fail the report open on a failed closing read.** Rejected in review. A loop with unreadable
   delivery evidence would then read as fully delivered, which is the gap this ADR closes.
5. **Read the closing references again in `batch status`.** Rejected. That command writes nothing
   and reads no network today, and the success checkpoint holds the fact.
6. **Derive the closing fact from the loop report only.** Rejected. The finish summary has no
   closing reference, and the observed loop reported both a `notDone` and a non-closing pull
   request, which are separate facts.
7. **Copy the closing-keyword rules into the batch delivery check.** Rejected in review. The
   eligibility helpers are the one implementation, so a body keyword or a commit message that the
   eligibility check recognizes is recognized here too.

## Links

- [Issue #2049: Mark a succeeded batch loop whose finish summary reports the item not done](https://github.com/andromarces/agent-loops/issues/2049)
- [PR #2051: Mark a succeeded batch loop that does not deliver its item](https://github.com/andromarces/agent-loops/pull/2051)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [ADR 0115: Report each loop's final report in the batch summary](0115-batch-loop-final-report.md)
- [ADR 0131: Name the undeclared pull request of a batch loop](0131-name-the-undeclared-pull-request-of-a-batch-loop.md)
- [ADR 0176: Report batch pull requests that change the same files](0176-report-batch-pull-requests-that-change-the-same-files.md)
- [Implementation: loop entry and partial reasons](../src/batch/loop-records.mjs)
- [Implementation: loop success](../src/batch/supervisor.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Implementation: closing evidence](../src/batch/eligibility.mjs)
- [Tests: batch outcomes](../tests/batch/supervisor.outcomes.test.mjs)
- [ADR Index](README.md)
