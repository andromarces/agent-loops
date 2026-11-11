# 0126. Keep review-only reviewer items in separate report fields

## Status

accepted

## Supersedes

This ADR partially supersedes [adr/0115-batch-loop-final-report.md](0115-batch-loop-final-report.md). The replaced parts are decision 2's report field list and decision 11's cap rule for copied values. Every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-11

## Context

A `review-only` loop report merged the reviewer findings, blockers, notes, and deferred items into one `findings` value. A reader saw no label to tell a blocker from a note or a deferred item.

`redactValue` kept the first 20 entries of a copied array and dropped the rest without a count. A capped list then read as complete. [ADR 0115](0115-batch-loop-final-report.md) required an overflow count for the capped warning list only.

## Decision

1. A `review-only` report keeps the reviewer verdict in `verdict`. The four reviewer item lists stay in `reviewerFindings`, `reviewerBlockers`, `reviewerNotes`, and `reviewerDeferred`.
2. These names differ from every finish `summary` key: `changed`, `verified`, `deferred`, `notDone`, `open`, and `notes`.
3. A reviewer value that is absent, blank, or `none` stays null.
4. In `redactValue`, a capped array keeps its first 20 entries and reports its dropped count.
5. A count sits beside its array as `<field>Overflow`, such as `reviewerFindingsOverflow`. Overflow is the source total minus the kept entries when the source carries a total. Otherwise it is the count that the local cap dropped. The count is never negative.
6. A nested array inside `failedTurnTest` gets the same count beside it, such as `commandOverflow`.
7. `warnings` keeps its `warningsOverflow` field.
8. Every copied value goes through `redactAndClean` or `redactValue` at the reporting boundary.
9. The test-run producer records `lateChangedCount` before the 20-path cap, or null with a null `lateChangedPaths`.

## Consequences

- A reader tells a blocker from a note or a deferred item.
- A capped list names the entries it dropped, so a partial list never reads as complete.
- An uncapped array reports no overflow.
- An unread or missing record carries no reviewer field.
- The report shape gains four reviewer fields and one count per capped array.

## Alternatives

1. **Keep one merged `findings` value.** Rejected. It loses the label of each reviewer item.
2. **Prefix each merged entry with its label.** Rejected. A reader then parses text instead of a field.
3. **Cap each array without a count.** Rejected. A partial list reads as complete, which is the defect.

## Authors

Andro Marces

## Links

- [Issue #1825: Keep review-only reviewer items by label and count dropped entries](https://github.com/andromarces/agent-loops/issues/1825)
- [PR #1833: Keep review-only reviewer items in separate report fields](https://github.com/andromarces/agent-loops/pull/1833)
- [ADR 0115: Report each loop's final report in the batch summary](0115-batch-loop-final-report.md)
- [Implementation: batch loop report](../src/batch/report.mjs)
- [Tests: batch loop report](../tests/batch/report.test.mjs)
- [Docs: batch loop report shape](../docs/reference/usage.md)
- [ADR Index](README.md)
