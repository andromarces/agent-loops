# 0127. Notify when only owner merges remain in a batch

## Status

accepted

Partially supersedes [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md). The replaced part is the event list of decision 6, which names three events.

## Supersedes

This ADR partially supersedes [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md). The replaced part is the event list of decision 6, which names three events. Every other part of decision 6, including the notifier mechanics, and every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-11

## Context

Decision 6 sent a `merge-required` event when an issue first entered `waiting`. The blocker loop could still be queued or running then, so no merge was possible.

No event fired when the last active loop settled and only `waiting` loops remained. The final settle computed the `waiting` status after the waiting poll ended. The foreground command then stayed silent until the owner merged.

Batch `20261111-051729-b56b9466` showed the gap on 2026-11-11. Issues #1779 and #1778 waited on #1811 and #1773. Their pull requests were ready by 06:00 UTC, and no notification or progress line said so.

## Decision

1. **One event when only waiting loops remain.** The supervisor reads the loop records after a loop settles, after each waiting refresh, and before a waiting poll sleep. It sends one notification and writes one progress line when no loop is `queued` or `running` and at least one loop is `waiting`.
2. **The text names each blocker and its open pull request.** Each blocking issue is named. A blocker loop in this batch with a recorded `pr` adds that pull request number. A blocker without a record is named by its issue number only, and the text never states that it has no pull request. The batch adds no GitHub read on the poll for this text.
3. **One send per entry into the state.** The supervisor marks the state as sent. The mark clears when a loop becomes `queued` or `running` again. An interrupt or a hard stop sends nothing.
4. **The first `merge-required` event stays.** A waiting issue still sends `merge-required` on its first entry into `waiting`. The new event is separate and fires when no active loop remains.
5. **`batch resume` treats the waiting-only state as a new entry.** A resume that finds no queued or running loop and at least one waiting loop sends the event once and writes one progress line. A resume with a queued or running loop sends nothing until the last one settles. The sent mark lives in memory, so a later resume sends again.

The acceptance checks are these. When no loop is queued or running and at least one loop is waiting, the batch sends one notification and writes one progress line. Both name each blocking issue and its open pull request when one exists. The batch sends once per entry into that state.

## Consequences

- The owner learns that every active loop is done and only merge decisions remain.
- The blocker pull request comes from the loop record, so the poll stays free of new GitHub reads.
- A resumed batch reports the waiting-only state again, so a stale in-memory mark never hides it.
- A blocker with no recorded pull request is named by issue number only, and the text makes no claim about its pull request.

## Alternatives

1. **Send on every 15-second poll.** Rejected. It repeats one unchanged state and trains the owner to ignore it.
2. **Read the blocker pull request on each poll.** Rejected. It adds a GitHub read for data the batch already holds.
3. **Persist the sent mark in the manifest.** Rejected. A resume then hides the waiting-only state from the owner.
4. **Replace the first `merge-required` event.** Rejected. That event reports the first entry into `waiting`, when no merge is possible yet.

## Links

- [Issue #1828: Notify when only owner merges remain in a batch](https://github.com/andromarces/agent-loops/issues/1828)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [ADR 0117: State the held-lock paused rule and its precedence in batch resume](0117-state-the-held-lock-paused-rule-and-its-precedence.md)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Tests: batch supervisor notifications](../tests/batch/supervisor.notifications.test.mjs)
- [ADR Index](README.md)
