# 0100. Arm the main work tree watch before the child turn

## Status

accepted

Partially supersedes [ADR 0080: Report a main work tree change that a turn restores inside its window](0080-report-a-main-work-tree-change-inside-a-turn-window.md), decision 1. It replaces decision 1's start rule. The start now waits for the stream to arm before it returns the handle. ADR 0080 decisions 2 to 8, its caps, its close-then-drain order, and its 1000 ms drain deadline stay in force. [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md) and its modification-time rule stay in force.

## Date

2026-11-08

## Context

`fs.watch(root, { recursive: true })` returns on macOS before the FSEvents stream starts on its own thread. A write that lands in the same event-loop turn can then be dropped, and `mainWorkTreeChangedInTurn` omits the path. Issue #1628 records three macOS CI misses and a local probe that reopened one root and missed a first write.

A local probe on macOS 27.3 with Node v27.0.0-alpha.0.0.0 reopened one root and wrote once per iteration. A synchronous write right after `watch` missed 1 of 10,000 events. A write after one event-loop turn missed 0 of 5,000, and one after a 0 ms timer missed 0 of 5,000.

## Decision

1. **Arm before the child.** `startMainWorkTreeWatch` resolves only after the stream arms. On macOS the watch factory resolves its `ready` promise after one event-loop turn. The other platforms resolve no `ready`, so their event handling does not change.
2. **One deadline.** The arm wait has one monotonic deadline of 1000 ms, computed with `performance.now`.
3. **Turn abort.** The turn abort signal ends the arm wait, closes the stream, and returns no handle.
4. **Failure.** A watch error, a stream close before the turn reads it, or a missed deadline reports no field and logs a warning. No path is dropped silently.
5. **Unchanged.** The caps, the overflow rule, the close-then-drain order, and the 1000 ms drain deadline of ADR 0080 stay unchanged.

## Consequences

- A child call starts only after the macOS stream arms, so a same-turn write is not issued before the stream is live.
- A worker turn pays one event-loop turn on macOS, and no added wait on Linux or Windows.
- A stream that never arms costs the 1000 ms deadline, reports no field, and warns.
- A cancel during the arm wait closes the stream and returns no handle.
- The measured miss rate is 1 in 10,000 for a same-turn write, so a rare OS-level drop outside this race stays possible.

## Alternatives

1. **Write a sentinel file in the main work tree to prove the stream is live.** Rejected. The watch observes user files, so the sentinel is a user-visible change.
2. **Wait for the first watch event as the arm signal.** Rejected. A turn that writes nothing never arms and fails.
3. **Rescan the main work tree at the turn end.** Rejected. It reads every main work tree entry on every turn, which the watch exists to avoid.
4. **Leave the start rule as it is.** Rejected. The reproduced same-turn miss stays.

## Authors

Andro Marces

## Links

- [Issue #1628](https://github.com/andromarces/agent-loops/issues/1628)
- [Issue #1544](https://github.com/andromarces/agent-loops/issues/1544)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md) (decision 1 superseded)
- [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md)
- Implementation: `startMainWorkTreeWatch` and `watchRecursive` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)
