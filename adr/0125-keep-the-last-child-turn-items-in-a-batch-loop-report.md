# 0125. Keep the last child turn items in a batch loop report

## Status

accepted

## Supersedes

This ADR partially supersedes [adr/0115-batch-loop-final-report.md](0115-batch-loop-final-report.md). The replaced part is decision 2's report field list. Decision 2 now adds `lastTurnItems` to a read report with no finish summary. Every other decision, consequence, and acceptance check of ADR 0115 stays in force.

## Date

2026-11-11

## Context

A batch loop report takes `summary` from the last `finish` action of the last attempt, as decision 4 of [adr/0115-batch-loop-final-report.md](0115-batch-loop-final-report.md) states. A loop that ends `failed`, `interrupted`, or `needs-owner` before a `finish` reports `summary: null`. Each child turn already reports Deferred, Notes, and Blockers in its closing block, and the transcript records them in its `result` event. The report drops those items, so a parent reads the transcript to surface them (issue #1824).

## Decision

1. **Field.** A read report with `summary: null` carries `lastTurnItems`. A read report with a finish summary carries no such key, and its shape stays unchanged.
2. **Value.** `lastTurnItems` holds `role`, `deferred`, `notes`, and `blockers` from the parsed report of the last `result` event of the last attempt. `role` names the turn that reported them.
3. **Missing turn.** A last attempt with no child result reads `reason` "the last attempt holds no child result" and null items.
4. **Missing report.** A last child result with no parsed report reads `reason` "the last child turn has no parsed report" and null items. A reason names the cause, so no absent item reads as "none".
5. **Redaction.** Every copied item passes through the existing redaction helper at this reporting boundary.
6. **Fail closed.** An `unread`, `missing`, or `no-attempt` report keeps its current shape and carries no `lastTurnItems`.

## Consequences

- A parent surfaces the last child turn items of an unfinished loop without a transcript read.
- A reader never sees the items as a finish summary, because the field sits apart from `summary`.
- A loop with a finish summary keeps one report shape.
- A failed, interrupted, or needs-owner loop with no child result states that it has none.

## Links

- [Issue #1824: Keep the last turn's Deferred, Notes, and Blockers when a batch loop ends without a finish](https://github.com/andromarces/agent-loops/issues/1824)
- [PR #1832: Keep the last turn items when a batch loop ends without a finish](https://github.com/andromarces/agent-loops/pull/1832)
- [adr/0115-batch-loop-final-report.md](0115-batch-loop-final-report.md)
- [Implementation: batch loop report](../src/batch/report.mjs)
- [Tests: batch loop report](../tests/batch/report.test.mjs)
- [Reference: batch loop statuses and the summary](../docs/reference/usage.md)
- [ADR Index](README.md)
