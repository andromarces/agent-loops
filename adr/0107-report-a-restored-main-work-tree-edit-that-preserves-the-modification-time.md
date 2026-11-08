# 0107. Report a restored main work tree edit that preserves the modification time

## Status

accepted

Partially supersedes [ADR 0086: Leave out a read-only access whose modification time predates the turn window](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md) decisions 2 and 5. It replaces decision 2's modification-time test with a modification-or-change-time test, and decision 5's limit. ADR 0086 decision 1, decision 3's 2000 ms margin, and decision 4 stay in force. ADR 0080 decisions 2 to 8 and ADR 0100 stay in force.

## Date

2026-11-08

## Context

ADR 0086 drops a candidate whose end modification time is before the turn window, because a read moves only the access time. Decision 5 records the limit that this filter accepts: a restore that preserves the old modification time is not reported.

A copy that preserves times, a `touch -r` restore, and a rename away and back all keep the modification time. A worker turn can use them to edit a main work tree file and restore it. The path then leaves both fields: `mainWorkTreeChanged` sees an unchanged state, and the in-turn watch drops the candidate by its old modification time. Issue #1712 records this as the remaining gap in a worker edit of the main work tree.

A write, a rename, a `chmod`, and an explicit `utimes` move the change time (`ctime`) on Windows, macOS, and Linux. A read moves only the access time. The change time therefore separates a read-only access from a write that restores the modification time.

## Decision

1. **Confirmation.** A candidate is reported when its pre-turn and post-turn state are equal, as ADR 0080 states, and its modification time **or** its change time at the turn end is not earlier than the window start minus the margin.
2. **Read-only access.** A read moves only the access time, so both its modification time and its change time stay before the window, and it is still dropped.
3. **Margin.** The margin of ADR 0086 stays 2000 ms, and it applies to both times.
4. **Limit.** A write that also restores the change time is not reported. The supported platforms give user code no way to set the change time, so this limit needs no instruction text.
5. **Unchanged.** The window start, the content state test, the caps, the close-then-drain order, the drain deadline, and the arm rule of ADR 0080 and ADR 0100 stay in force.

## Consequences

- A restored edit that preserves the modification time is reported, such as a copy that preserves times, a `touch -r` restore, or a rename away and back.
- A `chmod` and its restore are reported.
- A read-only access still reports no path.
- A path whose change time moved within the margin before the window can still be reported. The field proves no actor, so the parent reports a false positive under `open`.
- The end `lstat` that the watch already takes supplies both times, so the rule reads no file content.

## Alternatives

1. **Keep the modification-time rule.** Rejected. It leaves the confirmed gap that issue #1712 records.
2. **Compare the change time only.** Rejected. A coarse file system clock and a small skew still need the modification time and the margin; the rule keeps both signals and drops the candidate only when both predate the window.
3. **Read every candidate twice, before and after the turn.** Rejected. The watch exists to avoid a full read of the main work tree on every turn.
4. **Stop the run on the field.** Rejected in ADR 0101 decision 3. A concurrent run can report the same path, so the runtime cannot attribute the edit to one run.

## Authors

Andro Marces

## Links

- [Issue #1712](https://github.com/andromarces/agent-loops/issues/1712)
- [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md) (decisions 2 and 5 superseded)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md)
- [ADR 0100](0100-arm-the-main-work-tree-watch-before-the-child-turn.md)
- Implementation: `fileCandidates` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`, `tests/child-turn.main-work-tree.test.mjs`
- [ADR Index](README.md)
