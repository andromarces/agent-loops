# 0130. Start the main work tree watch window from the sub-millisecond clock

## Status

accepted

Partially supersedes [ADR 0116: Start the main work tree watch window from the system clock](0116-start-the-main-work-tree-window-from-the-system-clock.md). The replaced parts are decision 1's clock, decision 2's guard value, decision 3's limit value, and decision 4's test values. Decision 5 stays in force. The guard changes from 2.5 ms to 2.1 ms.

## Date

2026-11-12

## Context

The Windows case "a timestamp-preserving change just before the start reports no candidate" failed twice after PR #1743. Run 42645195259 recorded a change-time delta of 2.593 ms, and run 43040477161 recorded 2.551 ms. Both are deltas against `Date.now()`.

A temporary probe ran on the five `windows-tests` shards of run 43155705480 at head `d6d2fd89`. It measured 1,000 samples for each set, against both `Date.now()` and the performance clock.

`Date.now()` steps in whole milliseconds, so its start reads up to 1 ms early. The probe put the pre-window maximum at 2.005 ms against that start and 1.511 ms against the sub-millisecond start. The saved restore minimum rose from 2.727 ms to 2.765 ms. The gap between the sets rose from 0.722 ms to 1.254 ms.

The step between the two clocks reached 1.121 ms on one pre-window sample. The per-process offset ranged from -0.848 ms to 0.210 ms. One start serves both sets, so that offset moves every delta by one amount and leaves the gap.

## Decision

1. **Clock.** The window start comes from `performance.timeOrigin + performance.now()`, which keeps the sub-millisecond step of the file system stamp.
2. **Guard.** The change-time guard is 2.1 ms. It sits 0.589 ms above the saved pre-window maximum and 0.665 ms below the saved restore minimum.
3. **Limit.** An in-window restore inside 2.1 ms after the start is not reported.
4. **Test.** The restore case keeps its 4 ms wait. The regression test sets the system clock exactly 2.593 ms before the settled file stamp, so the saved maximum stays red against the old start.
5. **Unchanged.** The 2000 ms margin, the caps, the bounds, the deadline, and the fail-closed paths stay in force. ADR 0107 decisions 1, 2, 4, and 5 stay in force.

## Consequences

- A pre-window change time up to 1.511 ms after the start reports no path.
- All 1,000 saved restores at the 4 ms wait remain reported, and the earliest sat 2.765 ms after the start.
- A restore within 2.1 ms after the start is not reported.
- The guard is smaller than the ADR 0116 value, and the saved pre-window maximum under the new start is 0.494 ms lower.
- The 2.593 ms and 2.551 ms records include a `Date.now()` step of up to 1.121 ms, which the new start removes.

## Alternatives

1. **Keep the system-clock start.** Rejected. The saved gap is 0.722 ms with that start and 1.254 ms with the sub-millisecond start.
2. **Keep the system start and raise the guard above 2.593 ms.** Rejected. The saved restore minimum of 2.896 ms leaves 0.303 ms, the thin margin of issue #1887.
3. **Keep the 2.5 ms guard with the new start.** Rejected. The saved restore minimum leaves 0.265 ms.
4. **Read a start stamp from a probe file.** Rejected in ADR 0116 alternative 4. It adds a write and a read to every turn.
5. **Raise the restore-case wait.** Rejected. It removes the early-restore coverage.

## Authors

Andro Marces

## Links

- [Issue #1887: Separate a pre-window change from a restore on Windows runners past the 2.5 ms guard](https://github.com/andromarces/agent-loops/issues/1887)
- [PR #1892](https://github.com/andromarces/agent-loops/pull/1892)
- [ADR 0116](0116-start-the-main-work-tree-window-from-the-system-clock.md) (decisions 1, 2, 3, and 4 replaced)
- Implementation: `windowStart` and `CHANGE_TIME_GUARD_MS` in `src/lib/evidence/main-work-tree-watch.mjs`
- Tests: `tests/lib/evidence/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)

## Probe

Runner output saved from run 43155705480 on 2026-11-12 at head `d6d2fd89` of PR #1892. The workflow ran five `windows-tests` shards on `windows-latest` with Node v24.22.2. Each set holds 1,000 samples.

- Pre-window change against `Date.now()`: min -11.293 ms, p50 0.249 ms, p90 0.944 ms, p99 1.502 ms, max 2.005 ms.
- Pre-window change against the sub-millisecond clock: min -11.997 ms, p50 0.128 ms, p90 0.938 ms, p99 1.431 ms, max 1.511 ms.
- Restore at the 4 ms wait against `Date.now()`: min 2.727 ms, p50 4.774 ms, p90 5.622 ms, p99 6.306 ms, max 10.678 ms.
- Restore at the 4 ms wait against the sub-millisecond clock: min 2.765 ms, p50 5.096 ms, p90 6.074 ms, p99 6.684 ms, max 10.559 ms.
- The step between the two clocks reached 1.121 ms on one pre-window sample, and the per-process offset ranged from -0.848 ms to 0.210 ms.
- The gap between the sets was 0.722 ms against `Date.now()` and 1.254 ms against the sub-millisecond clock.
- The two CI records put a pre-window change at 2.593 ms and 2.551 ms against `Date.now()`.
