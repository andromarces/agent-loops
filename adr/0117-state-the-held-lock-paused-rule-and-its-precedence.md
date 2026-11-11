# 0117. State the held-lock paused rule and its precedence in batch resume

## Status

accepted

Partially supersedes [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md). The replaced part is the status rule of decision 1, which lists the exit codes only. It also partially supersedes [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md). The replaced part is the held-lock sentence of decision 9, which states the `paused` report but states no precedence. Every other decision, consequence, and acceptance check of [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md) and [adr/0110-release-batch-slots-on-owner-decisions.md](0110-release-batch-slots-on-owner-decisions.md) stays in force.

## Date

2026-11-09

## Context

[PR #1730](https://github.com/andromarces/agent-loops/pull/1730) for
[issue #1728](https://github.com/andromarces/agent-loops/issues/1728) made
`agent-loop batch resume` report `paused` with reason `a loop is owned by another resume`
when it skips a loop whose resume lock another live resume holds, whatever the loop
checkpoint status.

[adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md) decision 1
lists the exit codes only, and its decision 6 skip list is written for the eligibility
refresh of a launch. [adr/0110-release-batch-slots-on-owner-decisions.md](0110-release-batch-slots-on-owner-decisions.md)
decision 9 states the held-lock `paused` report and that the loop keeps its existing
decision, but states no precedence against a loop that the resume examined. Issue #1735
asks for the rule and the precedence in an accepted ADR.

## Decision

1. **A held-lock skip reports `paused`.** A `batch resume` that does not take a loop's
   resume lock because another live resume holds it skips that loop and reports the batch
   status `paused` with reason `a loop is owned by another resume`, whatever the loop
   checkpoint status. The batch exits 1. The skipped loop keeps its checkpoint status,
   pending decision, claim, work tree, transcript, and remaining step budget.
2. **An examined loop keeps `failed` or `needs-owner` precedence.** A loop whose resume
   lock this resume takes is examined, so the held-lock pause does not apply to it, and it
   keeps its own `failed` or `needs-owner` status. The batch status then follows this order:
   a `waiting` or `needs-owner` loop makes the batch `waiting` with exit 1 before a `failed`
   loop makes it `failed` with exit 1. One `failed` loop beside one unanswered
   `needs-owner` loop therefore leaves the batch `waiting`, and a `failed` loop alone leaves
   it `failed`.
3. **A held-lock skip pauses the batch.** At least one held-lock skip reports the batch
   `paused` with reason `a loop is owned by another resume`, before the `waiting` and
   `failed` checks and whatever the other loop statuses. The summary still reports the
   status of every loop this resume examined. A batch-wide read failure and an interruption
   keep their existing status precedence.
4. **The skip writes no loop record.** The held-lock skip writes no loop checkpoint and
   launches no child. A resume that starts from `waiting` can write the batch manifest
   status `running` before the final `paused`, so the final status is not the only batch
   write. `batch status` still reads the checkpoint that the other resume owns.

## Consequences

- A resume that finds every loop lock held reports `paused`, not `failed`, `waiting`, or
  `completed`.
- A resume that examined failing or owner-bound work reports that loop status in the
  summary. The batch is `waiting` when any examined loop is `waiting` or `needs-owner`, and
  `failed` when the only examined trouble is a `failed` loop.
- An examined `needs-owner` loop remains a pending decision and, without another held lock,
  the batch exits with status `waiting`.
- The held loop keeps its checkpoint and decision, so a later resume can apply it.

## Alternatives

1. **Keep the rule only in ADR 0110 decision 9.** Rejected. It states the `paused` report
   but not the precedence, so a held `needs-owner` loop still read as `failed`
   ([issue #1728](https://github.com/andromarces/agent-loops/issues/1728)).
2. **Treat a held-lock skip as `failed`.** Rejected. Another resume owns the work, so
   the batch did not fail; it must wait for that resume.
3. **Treat a held-lock skip as `needs-owner`.** Rejected. The owner cannot answer a loop
   that another resume owns, and the batch would report `waiting` instead of `paused`.

## Links

- [Issue #1735: State the held-lock paused rule of batch resume in the ADR and link PR #1730](https://github.com/andromarces/agent-loops/issues/1735)
- [Issue #1728: Report paused when another resume holds the lock of a needs-owner batch loop](https://github.com/andromarces/agent-loops/issues/1728)
- [PR #1730: Report paused when a held lock skips a needs-owner loop](https://github.com/andromarces/agent-loops/pull/1730)
- [PR #1732: Release batch loop slots on owner decisions, resume after merges, and notify](https://github.com/andromarces/agent-loops/pull/1732)
- [PR #1745: State the held-lock paused rule and link PR #1730](https://github.com/andromarces/agent-loops/pull/1745)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Tests: batch supervisor recovery](../tests/batch/supervisor.recovery.test.mjs) and [batch supervisor decisions](../tests/batch/supervisor.decisions.test.mjs)
- [ADR Index](README.md)
