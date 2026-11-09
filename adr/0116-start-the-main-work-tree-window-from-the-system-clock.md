# 0116. Start the main work tree watch window from the system clock

## Status

accepted

Partially supersedes [ADR 0107](0107-report-a-restored-main-work-tree-edit-that-preserves-the-modification-time.md). The replaced parts are decision 3 and its Context sentence that the performance clock matches the file system stamp. The 2000 ms margin, the change-time guard, and decisions 1, 2, 4, and 5 stay in force. The guard changes from one millisecond to 2.5 ms.

## Date

2026-11-09

## Context

Issue #1740 records three Windows CI failures of two watch tests. Each setup called `utimes` just before the watch started, and the watch reported `init.txt`.

A Windows probe logged the watch start, `Date.now()`, the end change time, and their deltas. The replay of run 42565290214 reported 10 pre-window attempts at the `origin/main` comparison and 48 at head `23c5e73`. The new comparison reports 0 of 302.

The saved pre-window change times reached 2.100 ms after the system-clock start and 1.542 ms after the performance-clock start. The file system can also apply the change-time stamp after `utimes` returns.

The same run recorded 20 in-window timestamp-preserving restores from 2.896 ms to 5.971 ms after the system-clock start. The guard must separate the pre-window set from the restore set.

## Decision

1. **Clock.** The window start comes from `Date.now()`, the system clock that the file system stamp follows.
2. **Guard.** The change-time guard is 2.5 ms. The saved samples put pre-window change times at most 2.100 ms after the start and restores at least 2.896 ms after it.
3. **Limit.** An in-window restore inside 2.5 ms after the start is not reported.
4. **Test.** The two race-prone cases start without a wait. A regression test skews both process clocks 2.2 ms behind a settled file stamp.
5. **Unchanged.** The 2000 ms margin, the caps, the bounds, the deadline, the fail-closed paths, and ADR 0107 decisions 1, 2, 4, and 5 stay in force.

## Consequences

- A pre-window change up to 2.100 ms after the start reports no path.
- All 20 saved in-window restores remain reported.
- A restore within 2.5 ms after the start is not reported.
- The performance clock offset no longer erodes the guard, because the guard covers the stamp delay.

## Alternatives

1. **Keep the one-millisecond guard.** Rejected. It reported 48 of 302 saved pre-window attempts at head `23c5e73`.
2. **Keep the performance clock and widen the guard.** Rejected. The saved pre-window change reached 2.100 ms, and the saved performance start was 1.294 ms behind the system clock. A 3.4 ms guard covers both and reports 16 of 20 saved restores.
3. **Wait only in the tests.** Rejected. The production default then still reports the saved pre-window stamps.
4. **Read a file system stamp at the start.** Rejected. It needs a probe file and an extra read on every turn.

## Authors

Andro Marces

## Links

- [Issue #1740](https://github.com/andromarces/agent-loops/issues/1740)
- [PR #1743](https://github.com/andromarces/agent-loops/pull/1743)
- [ADR 0107](0107-report-a-restored-main-work-tree-edit-that-preserves-the-modification-time.md) (decision 3 and one Context sentence superseded)
- Implementation: `windowStart` and `CHANGE_TIME_GUARD_MS` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)
