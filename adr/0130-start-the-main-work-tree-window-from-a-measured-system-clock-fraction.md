# 0130. Start the main work tree watch window from a measured system-clock fraction

## Status

accepted

Partially supersedes [ADR 0116: Start the main work tree watch window from the system clock](0116-start-the-main-work-tree-window-from-the-system-clock.md). The replaced parts are decision 2's guard value, decision 3's limit value, and decision 4's test values. Decision 1 and decision 5 stay in force. The guard changes from 2.5 ms to 2.1 ms.

## Date

2026-11-12

## Context

The Windows case "a timestamp-preserving change just before the start reports no candidate" failed twice after PR #1743. Run 42645195259 recorded a change-time delta of 2.593 ms, and run 43040477161 recorded 2.551 ms. Both are deltas against a whole-millisecond `Date.now()` start.

ADR 0116 decision 1 keeps the system clock, which the file system stamp follows. The whole-millisecond step still places the start up to 1 ms before the reading, so a pre-window stamp reads up to 1 ms late. The probe of run 43155705480 put the gap between the sets at 0.722 ms with that start.

A start from the performance clock's wall time widened the measured gap. Its per-process offset does not cancel against a fixed guard, and ADR 0116 recorded a 1.294 ms offset. One run also keeps one clock origin across turns, so a system-clock correction leaves that start stale.

The chosen start reads `Date.now()` and spins to the next tick, bounded at 2 ms by `performance.now()` as an elapsed timer only. It subtracts the measured wait, so the start lands at the sub-millisecond fraction of the reading on the system clock. A tick jump or an overrun returns the plain reading. The read runs before the watch arms and before any child spawn.

The probe of run 43159161575 measured 1,000 samples for each set over 20 distinct processes. It ran four child processes per `windows-tests` shard.

## Decision

1. **Start.** The window start comes from `Date.now()` with the measured sub-millisecond fraction, and a bounded spin of 2 ms. A tick jump or an overrun returns the plain reading.
2. **Guard.** The change-time guard is 2.1 ms. It sits 0.832 ms above the saved pre-window maximum and 0.859 ms below the saved restore minimum.
3. **Limit.** An in-window restore inside 2.1 ms after the start is not reported.
4. **Test.** The restore case keeps its 4 ms wait. Two cases put a change at the saved pre-window maximum and a restore at the saved restore minimum.
5. **Unchanged.** ADR 0116 decision 1 and decision 5 stay in force, with the 2000 ms margin, the caps, the bounds, and the deadline.

## Consequences

- A pre-window change time up to 1.268 ms after the start reports no path.
- All 1,000 saved restores at the 4 ms wait remain reported, and the earliest sat 2.959 ms after the start.
- A restore within 2.1 ms after the start is not reported.
- The start adds a bounded spin before the watch arms, and the saved start delay ran from -0.043 ms to 1.000 ms.
- The guard is smaller than the ADR 0116 value. The saved pre-window maximum is 0.737 ms lower than the 2.005 ms saved for the plain start.

## Alternatives

1. **Keep the whole-millisecond start.** Rejected. The saved gap of 0.722 ms is the thin margin of issue #1887.
2. **Take the next tick value without the measured fraction.** Rejected. It is the plain reading plus one, so it moves both sets by one amount and widens no gap.
3. **Start from the performance clock's wall time.** Rejected. The per-process offset does not cancel against a fixed guard, and one origin serves every turn of a run.
4. **Read a start stamp from a probe file.** Rejected in ADR 0116 alternative 4. It adds a write and a read to every turn.
5. **Raise the restore-case wait.** Rejected. It removes the early-restore coverage.

## Authors

Andro Marces

## Links

- [Issue #1887: Separate a pre-window change from a restore on Windows runners past the 2.5 ms guard](https://github.com/andromarces/agent-loops/issues/1887)
- [PR #1892](https://github.com/andromarces/agent-loops/pull/1892)
- [ADR 0116](0116-start-the-main-work-tree-window-from-the-system-clock.md) (decisions 2, 3, and 4 replaced)
- Implementation: `readWindowStart` and `CHANGE_TIME_GUARD_MS` in `src/lib/evidence/main-work-tree-watch.mjs`
- Tests: `tests/lib/evidence/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)

## Probe

Runner output saved from run 43159161575 on 2026-11-12 at head `2861486b` of PR #1892. The workflow ran five `windows-tests` shards on `windows-latest` with Node v24.22.2. Four child processes per shard ran 50 rounds, so 20 processes and 1,000 samples for each set.

- Pre-window change against the measured-fraction start: min -2.055 ms, p50 -0.243 ms, p90 0.470 ms, p99 1.071 ms, max 1.268 ms.
- Restore at the 4 ms wait against the measured-fraction start: min 2.959 ms, p50 4.781 ms, p90 5.568 ms, p99 6.220 ms, max 7.484 ms.
- The start delay ran from -0.043 ms to 1.000 ms, with a p50 of 0.406 ms and a p99 of 0.993 ms.
- The gap between the sets was 2.959 ms minus 1.268 ms, which is 1.691 ms.
- The earlier probe of run 43155705480 used the plain start. It put the pre-window maximum at 2.005 ms and the restore minimum at 2.727 ms, a gap of 0.722 ms.
