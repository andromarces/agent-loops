# 0111. Start the main work tree watch window from the system clock

## Status

accepted

Partially supersedes [ADR 0107: Report a restored main work tree edit that preserves the modification time](0107-report-a-restored-main-work-tree-edit-that-preserves-the-modification-time.md) decision 3 and its Context sentence that the performance clock matches the file system stamp. The 2000 ms margin, the one-millisecond guard, and decisions 1, 2, 4, and 5 stay in force.

## Date

2026-11-09

## Context

Issue #1740 records three Windows CI failures of two watch tests. Each setup called `utimes` just before the watch started, and the watch reported `init.txt`.

A Windows probe logged the watch start, `Date.now()`, the end change time, and their deltas. Run 42565290214 ran the target file 20 times on `origin/main` and failed 8 times. The failing process with `timeOrigin=1794200785287.985` recorded a start 0.593 ms before `Date.now()` and a change time 1.542 ms after the start.

Across the failing processes, the start was at most 0.924 ms after `Date.now()` and mostly before it. The performance wall time therefore carries a per-process offset from the system clock. The offset reaches about one millisecond, and it shrinks the one-millisecond guard.

The probe also recorded pre-window change times up to 2.100 ms after `Date.now()` at the start. The file system can apply the change-time stamp after `utimes` returns. A setup that starts at once races that stamp.

## Decision

1. **Clock.** The window start comes from `Date.now()`, the system clock that the file system stamp follows. An internal `wallClock` option supplies the clock for a test.
2. **Guard.** The change-time guard stays one millisecond. The system clock steps in whole milliseconds, and a file stamp can lead it by less than one millisecond.
3. **Test setup.** A test that makes a pre-window timestamp-preserving change waits 20 ms before the start. The saved probe saw stamps up to 2.1 ms late.
4. **Unchanged.** The 2000 ms modification-time margin, the caps, the bounds, the deadline, the fail-closed paths, and ADR 0107 decisions 1, 2, 4, and 5 stay in force.

## Consequences

- A Windows process whose performance clock is behind the system clock no longer erodes the guard and reports a pre-window stamp.
- A test no longer races the file system change-time stamp.
- A pre-window change whose stamp lands more than one millisecond after the start is still reported.
- An in-window restore inside the one-millisecond guard after the start is still not reported.

## Alternatives

1. **Keep the performance clock and widen the guard.** Rejected. A guard that covers the stamp delay also hides an in-window restore.
2. **Wait only in the tests.** Rejected. The performance clock offset then still affects a real turn.
3. **Read a file system stamp at the start.** Rejected. It needs a probe file and an extra read on every turn.

## Authors

Andro Marces

## Links

- [Issue #1740](https://github.com/andromarces/agent-loops/issues/1740)
- [ADR 0107](0107-report-a-restored-main-work-tree-edit-that-preserves-the-modification-time.md) (decision 3 and one Context sentence superseded)
- Implementation: `wallClock` and `windowStart` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)
