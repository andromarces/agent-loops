# 0130. Start the main work tree watch window from a bounded system-clock fraction

## Status

accepted

Partially supersedes [ADR 0116: Start the main work tree watch window from the system clock](0116-start-the-main-work-tree-window-from-the-system-clock.md). The replaced parts are decision 2's guard value, decision 3's limit value, and decision 4's test values. Decision 1 and decision 5 stay in force. The guard changes from 2.5 ms to 2.25 ms.

## Date

2026-11-12

## Context

The Windows case "a timestamp-preserving change just before the start reports no candidate" failed twice after PR #1743. Run 42645195259 recorded a change-time delta of 2.593 ms, and run 43040477161 recorded 2.551 ms. Both are deltas against a whole-millisecond `Date.now()` start.

ADR 0116 decision 1 keeps the system clock, which the file system stamp follows. The whole-millisecond step still places the start up to 1 ms before the reading, so a pre-window stamp reads up to 1 ms late. The probe of run 43155705480 put the gap between the sets at 0.722 ms with that start.

A start from the performance clock's wall time does not work. Its per-process offset does not cancel against a fixed guard, and one run keeps one clock origin across turns. A start read from a probe file needs a write and a read on every turn.

The chosen start reads `Date.now()` and spins to the next tick, with `performance.now()` as an elapsed timer only. Each read sits between two performance clock readings. The spin accepts a tick only when both readings and the previous-read gap stay under 0.5 ms. A read, a gap, or a wait past the bound returns `base + 1`, the latest instant that the reading allows. Every path returns a value in `[base, base + 1]`, the interval that holds the call instant.

The probe of run 43163755445 measured 1,000 samples for each set over 20 distinct processes. It ran four child processes per `windows-tests` shard.

## Decision

1. **Start.** The window start comes from `Date.now()` with a bounded spin of 2 ms and a read bound of 0.5 ms. Every path returns a value in `[base, base + 1]`, and the fallback is `base + 1`.
2. **Guard.** The change-time guard is 2.25 ms on an accepted start. It sits 0.464 ms above the saved pre-window maximum and 0.482 ms below the saved restore minimum. The fallback start uses a 1.8 ms guard, so its cutoff is `base + 2.8`.
3. **Limit.** An accepted start does not report an in-window restore inside 2.25 ms after it. A fallback start does not report a restore inside 1.8 ms after it.
4. **Test.** The restore case keeps its 4 ms wait. Five cases pin the recorded pre-window delta, the preempted read, the spin overrun, the saved restore minimum, and the fallback restore.
5. **Unchanged.** ADR 0116 decision 1 and decision 5 stay in force, with the 2000 ms margin, the caps, the bounds, and the deadline.

## Consequences

- An accepted start reports no pre-window change time up to 1.786 ms after it.
- All 1,000 saved restores at the 4 ms wait remain reported, and the earliest sat 2.732 ms after an accepted start.
- An accepted start does not report a restore within 2.25 ms after it.
- The fallback start uses a 1.8 ms guard, so its cutoff is `base + 2.8`.
- A pre-window change at 1.786 ms after the fallback start sits below that cutoff, and a restore at 2.732 ms after it is reported.
- The spin adds a bounded delay before the watch arms, and the probe ran 9 fallbacks and 3 retries in 2,000 calls.

## Alternatives

1. **Keep the whole-millisecond start.** Rejected. The saved gap of 0.722 ms is the thin margin of issue #1887.
2. **Return the plain reading on an overrun.** Rejected. The recorded 2.551 ms delta then stays past the 2.25 ms guard.
3. **Take the next tick value without the measured fraction.** Rejected. It is the plain reading plus one, so it moves both sets by one amount and widens no gap.
4. **Start from the performance clock's wall time.** Rejected. The per-process offset does not cancel against a fixed guard, and one origin serves every turn of a run.
5. **Read a start stamp from a probe file.** Rejected in ADR 0116 alternative 4. It adds a write and a read to every turn.
6. **Raise the restore-case wait.** Rejected. It removes the early-restore coverage.

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

Runner output saved from run 43163755445 on 2026-11-12 at head `220983f5` of PR #1892. The workflow ran five `windows-tests` shards on `windows-latest` with Node v24.22.2. Four child processes per shard ran 50 rounds, so 20 processes and 1,000 samples for each set.

- Pre-window change against the bounded start: min -1.940 ms, p50 0.089 ms, p90 0.892 ms, p99 1.624 ms, max 1.786 ms.
- Restore at the 4 ms wait against the bounded start: min 2.732 ms, p50 5.135 ms, p90 6.016 ms, p99 6.650 ms, max 109.242 ms.
- The start paths ran 1,991 accepted, 3 retries, and 9 fallbacks in 2,000 calls.
- The gap between the sets was 2.732 ms minus 1.786 ms, which is 0.946 ms.
- The earlier probe of run 43155705480 used the plain start. It put the pre-window maximum at 2.005 ms and the restore minimum at 2.727 ms, a gap of 0.722 ms.
