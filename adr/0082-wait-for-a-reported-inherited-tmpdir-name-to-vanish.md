# 0082. Wait for a reported inherited temporary directory name to vanish

## Status

partially-superseded

Partially supersedes [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md). It replaces decision 2's single read and decision 8's single re-read after a reviewer turn. It also replaces the consequence that the re-check makes no claim about a later state.

Partially superseded by [ADR 0093: Report a held inherited temporary directory name apart from the possible leftovers](0093-report-a-held-inherited-tmpdir-name-apart-from-the-possible-leftovers.md). It replaces decision 2's single report with the present list and the settled list.

Decisions 1 and 4 to 7, decision 3's parent-only and parent-session rules, and every other consequence of ADR 0081 remain in force. [ADR 0085: Let the inherited temporary directory re-check read a terminal run](0085-let-the-tmpdir-re-check-read-a-terminal-run.md) replaces decision 3's non-terminal requirement.

## Date

2026-11-06

## Context

ADR 0081 re-reads the recorded names once, right before the finish summary. When the finish follows the last reviewer turn within a minute, that read runs while transient GUID `.tmp` files still exist. Every name then reaches `open`, and none needs action (issue #1569). The observed names were gone about 15 minutes later.

A single read cannot separate a transient name from a leftover. A bounded later read can. A name that another process removes within minutes leaves the list, and a name that stays reaches the report.

## Decision

1. **Poll with a fixed bound and interval.** `role recheck-tmpdir` re-reads the recorded names every 2 seconds, for at most 3 minutes. It returns as soon as every checkable name is gone, and otherwise reports the final read by the bound.
2. **Report the last read.** The envelope keeps its shape. Every read checks every originally recorded name, and the report is the result of the last read. A name that another process created again counts as present.
3. **Fail closed.** A failed or over-bound read on the first poll keeps every name and ends the wait. A later failed poll keeps every name that the last successful read still held.
4. **Keep an uncheckable name.** A name that the read cannot check stays listed. The first failed read ends the wait, because no later read can prove that name gone.
5. **No wait when none can help.** An empty name list returns at once. A list with no checkable name returns at once, because a later read changes no name. A missing inherited directory counts as a first failed read and keeps every name.
6. **Bound the clock.** The deadline uses a monotonic clock, so a wall-clock jump never ends or extends the wait. The final read starts one read bound before the deadline, so every read ends by the bound. The bound starts after the run state read and covers every directory read.
7. **End on cancel.** A SIGINT ends the sleep and an in-flight read at once with the cancel envelope. It deletes nothing.
8. **Headless path.** The runtime waits only after a reviewer turn whose verdict is accept, because only an accept can lead to a finish. Every other verdict keeps the single read with no wait.
9. **Keep it testable.** `presentInheritedTmpdir` accepts the bound, the interval, the read, the clock, and the sleep. A test injects each with no real minute wait.

## Consequences

- A GUID `.tmp` file is excluded when the last read, which ends by the deadline, no longer finds it.
- A finish that follows the last reviewer turn within a minute can now wait up to the bound for a transient name.
- A name that stays for the whole bound adds up to 3 minutes. On the headless path, that cost applies once per accepted reviewer turn.
- A name that one read misses stays eligible, so a recreated name reaches the report.
- The report comes from the last read, which starts one read bound before the deadline.
- A name removed after the bound still reaches the summary, because no wait proves a later state.
- A redacted or unsafe name always reaches `open`, because the read cannot prove it gone, but it adds no wait.
- A cancel before the bound ends the command with no envelope names, and no name is deleted.
- The command still deletes nothing and writes no run state.

## Alternatives

1. **Keep the single read.** Not taken. It produced the issue, because the finish follows the reviewer turn too closely.
2. **State the order in the orchestrator instructions only.** Not taken. `docs/orchestrator-instructions.md` is at the 50,000-byte cap, and the parent cannot move the finish later.
3. **Wait in the reviewer settle.** Not taken. That settle runs inside the turn and cannot wait for a later removal.
4. **Leave out a GUID `.tmp` name by its pattern.** Not taken, for the reason in ADR 0081.

## Authors

Andro Marces

## Links

- [Issue #1569](https://github.com/andromarces/agent-loops/issues/1569)
- [PR #1570](https://github.com/andromarces/agent-loops/pull/1570)
- [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md)
- Implementation:
  - Re-check: `presentInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Parent command: `recheck-tmpdir` in `src/role/index.mjs`
  - Headless read: `src/runtime.mjs`
  - Docs: `docs/reference/role.md`, `docs/orchestrator/runtime-advisory-fields.md`, and `src/help.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.recheck-tmpdir.test.mjs`, and `tests/runtime.inherited-tmpdir.test.mjs`
- [ADR Index](README.md)
