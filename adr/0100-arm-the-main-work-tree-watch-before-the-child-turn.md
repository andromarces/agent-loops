# 0100. Arm the main work tree watch before the child turn

## Status

accepted

Partially supersedes [ADR 0080: Report a main work tree change that a turn restores inside its window](0080-report-a-main-work-tree-change-inside-a-turn-window.md), decision 1. It replaces decision 1's start rule. The start now waits for the `ready` promise that the watch factory supplies before it returns the handle. ADR 0080 decisions 2 to 8, its caps, its close-then-drain order, and its 1000 ms drain deadline stay in force. [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md) and its modification-time rule stay in force.

## Date

2026-11-08

## Context

A local probe on macOS 27.3 with Node v27.0.0-alpha.0.0.0 reopened one root and wrote once per iteration. A synchronous write right after `watch` missed 1 of 10,000 events. A write after one event-loop turn missed 0 of 5,000, and one after a 0 ms timer missed 0 of 5,000. The product watch missed 0 of 2,000 writes after the arm.

The probe does not establish the native cause. It shows that a write right after `watch` can be dropped and that one event-loop turn avoided the drop in the saved runs. Issue #1628 records three macOS CI misses and a local probe that reopened one root and missed a first write. The 5 in 1,000 reopen rate of #1544 was not reproduced.

## Decision

1. **Wait for `ready`.** `startMainWorkTreeWatch` resolves after the watch factory's `ready` promise. On macOS the default factory resolves `ready` after one event-loop turn. The other platforms return no `ready`, so their event handling does not change.
2. **One deadline.** The wait has one monotonic deadline of 1000 ms, computed with `performance.now`.
3. **Turn abort.** The turn abort signal ends the wait, closes the watch, and returns no handle.
4. **Failure.** A watch error, a watch close before the turn reads it, or a missed deadline reports no field and logs a warning. No path is dropped silently.
5. **Unchanged.** The caps, the overflow rule, the close-then-drain order, and the 1000 ms drain deadline of ADR 0080 stay unchanged.

## Consequences

- A child call starts after the macOS `ready` promise resolves, one event-loop turn after `watch`.
- A worker turn pays one event-loop turn on macOS, and no added wait on Linux or Windows.
- A `ready` promise that does not resolve costs the 1000 ms deadline, reports no field, and warns.
- A cancel during the wait closes the watch and returns no handle.
- The saved probe missed 1 in 10,000 writes right after `watch` and 0 in 5,000 after one event-loop turn. The product watch missed 0 in 2,000 writes after the arm. A rare OS-level drop outside this case stays possible. The 5 in 1,000 reopen rate of #1544 was not reproduced.

## Alternatives

1. **Write a sentinel file in the main work tree to test the watch.** Rejected. The watch observes user files, so the sentinel is a user-visible change.
2. **Wait for the first watch event as the ready signal.** Rejected. A turn that writes nothing never resolves it and fails.
3. **Rescan the main work tree at the turn end.** Rejected. It reads every main work tree entry on every turn, which the watch exists to avoid.
4. **Leave the start rule as it is.** Rejected. The reproduced right-after-`watch` miss stays.

## Authors

Andro Marces

## Links

- [Issue #1628](https://github.com/andromarces/agent-loops/issues/1628)
- [Issue #1544](https://github.com/andromarces/agent-loops/issues/1544)
- [Pull request #1629](https://github.com/andromarces/agent-loops/pull/1629)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md) (decision 1 superseded)
- [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md)
- Implementation: `startMainWorkTreeWatch` and `watchRecursive` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)
