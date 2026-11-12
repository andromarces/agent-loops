# 0130. Widen the change-time guard to four milliseconds

## Status

accepted

Partially supersedes [ADR 0116: Start the main work tree watch window from the system clock](0116-start-the-main-work-tree-window-from-the-system-clock.md). The replaced parts are decision 2's guard value, decision 3's limit value, and decision 4's test values. Decision 1, decision 2's clock, and decision 5 stay in force. The guard changes from 2.5 ms to 4 ms.

## Date

2026-11-12

## Context

The Windows case "a timestamp-preserving change just before the start reports no candidate" failed twice after PR #1743. Run 42645195259 recorded a change-time delta of 2.593 ms, and run 43040477161 recorded 2.551 ms. Both sit past the 2.5 ms guard of ADR 0116.

A temporary probe ran on the five `windows-tests` shards of run 43151456920 at head `e0272b3a`. It measured 200 rounds per shard, so 1,000 samples for each set.

Set one is a timestamp-preserving change time minus the window start. Set two is an in-window timestamp-preserving restore time minus the window start, after a 4 ms, 6 ms, or 8 ms wait.

The two sets must separate at one guard. The probe restore minimum lies up to 1 ms below its wait, because `Date.now()` returns whole milliseconds. A start offset moves both sets by the same amount and widens no gap.

## Decision

1. **Guard.** The change-time guard is 4 ms. It sits 1.407 ms above the saved pre-window maximum and 3.044 ms below the saved restore minimum at an 8 ms wait.
2. **Restore wait.** The timestamp-preserving restore case waits 8 ms after the start. The saved restore minimum at that wait is 7.044 ms.
3. **Regression test.** The skew regression test skews both process clocks by the saved pre-window maximum of 2.593 ms.
4. **Start and margin.** The window start stays with `Date.now()`, and the 2000 ms modification-time margin stays.
5. **Unchanged.** Every other rule of ADR 0116 and ADR 0107 stays in force.

## Consequences

- A pre-window change time up to 2.593 ms after the start reports no path.
- All 1,000 saved restores at an 8 ms wait remain reported, and the earliest sat 7.044 ms after the start.
- A restore within 4 ms after the start is not reported.
- The 4 ms guard is larger, so a pre-window stamp has 1.407 ms more room than the 2.5 ms guard gave.

## Alternatives

1. **Keep the 2.5 ms guard.** Rejected. The saved pre-window values reached 2.593 ms.
2. **Raise the restore wait and keep 2.5 ms.** Rejected. The wait does not change the pre-window tail.
3. **Offset the window start past the integer millisecond.** Rejected. The offset moves both sets by the same amount.
4. **Wait at the production start.** Rejected. The wait holds the window later and the saved gap stays.
5. **Read a probe file stamp at the start.** Rejected in ADR 0107 alternative 4.

## Authors

Andro Marces

## Links

- [Issue #1887: Separate a pre-window change from a restore on Windows runners past the 2.5 ms guard](https://github.com/andromarces/agent-loops/issues/1887)
- [PR #1892](https://github.com/andromarces/agent-loops/pull/1892)
- [ADR 0116](0116-start-the-main-work-tree-window-from-the-system-clock.md) (decisions 2, 3, and 4 replaced)
- Implementation: `CHANGE_TIME_GUARD_MS` in `src/lib/evidence/main-work-tree-watch.mjs`
- Tests: `tests/lib/evidence/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)

## Probe

Runner output saved from run 43151456920 on 2026-11-12 at head `e0272b3a` of PR #1892. The workflow ran five `windows-tests` shards on `windows-latest` with Node v24.22.2.

- Set one, the pre-window change: 1,000 samples, min -1.451 ms, p50 0.449 ms, p90 1.186 ms, p99 1.918 ms, max 2.311 ms. No sample passed 2.5 ms.
- Set two at a 4 ms wait: 1,000 samples, min 3.057 ms, p50 4.989 ms, p90 6.010 ms, p99 7.792 ms, max 34.786 ms.
- Set two at a 6 ms wait: 1,000 samples, min 5.055 ms, p50 6.951 ms, p90 7.905 ms, p99 8.959 ms, max 31.870 ms.
- Set two at an 8 ms wait: 1,000 samples, min 7.044 ms, p50 9.009 ms, p90 10.048 ms, p99 12.001 ms, max 28.214 ms.
- The sub-millisecond clock read 0.390 ms to 1.469 ms above `Date.now()` over 2,000 pairs. The p50 was 0.571 ms and the p90 was 1.412 ms.
- The change-time fraction covered 0.000 ms to 1.000 ms in every shard, so the file system stamp has sub-millisecond resolution.
- The two CI records put a pre-window change at 2.593 ms and 2.551 ms. Both sit past the 1,000-sample maximum of 2.311 ms.
