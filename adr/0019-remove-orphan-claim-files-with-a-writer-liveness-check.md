# 0019. Remove orphan claim files with a writer liveness check

## Status

accepted

## Date

2026-10-05

## Context

A stale-lock takeover creates a claim file `state.lock.reap.<digest>` (#363, PR #370). A
process that crashes leaves it behind. Only a later contender that meets the same
stale lock removed it. Issue #377 (PR #445) kept that behavior, because two scan
designs for a removal outside a takeover were rejected in review:

- A scan that took over the guard of a dead claim removed an unwritten guard of a
  running process.
- The reverse order let the scan's own unwritten guard, or a guard that a takeover
  created, remove a claim of a running process, so two processes acted on one claim.

Both failed for one reason. A claim file that is created but not yet written (the
exclusive-create fallback for file systems without hard links) cannot be parsed.
Such a file was treated as stale once it was older than a 60 s grace window, so it
could not be told from a dead one, and a stalled running writer lost it.

Issue #452 asks for machinery that tells a running owner from a dead one without
the grace window, on Windows and POSIX, and keeps two invariants of PR #370:
exactly one process acts on each claim, and no path removes a lock or claim of a
running process. It also asks to check a reported PID-reuse window.

## Decision

1. **Writer evidence, not age.** `createLock` already writes a temp file
   `<file>.<pid>.<n>.tmp` before it creates the lock or claim, and removes it after
   the content is written. Between creation and write, that temp file is the only
   trace of the owner. `hasLiveWriter(file)` is true when a temp for `file` has a
   live pid. An unparseable file with a live writer is never taken over, at any age.
   The grace window and `STALE_LOCK_GRACE_MS` are removed.
2. **Stale means identified dead.** A file is stale when its parsed pid is dead, or
   when it is unparseable, readable, and has no live writer. A file that cannot be
   read, or that is missing, is kept and the contender exits as busy.
3. **Check under the claim.** Under the guard claim, `stillStale` re-reads the file.
   A parsed owner's content is unique (nonce), so equal content is the same file. An
   unparseable file has no unique content, so the check also compares the file
   identity (inode, size, mtime, ctime, as nanosecond values) before and after the
   writer check. A later file at the same path therefore never matches.
4. **Scan.** After a successful root lock acquisition, `pruneOrphanClaims` lists the
   claims beside the lock and removes each orphan through the existing claimed
   removal. The guard is keyed by the claim's name and content, the same key a
   takeover contender uses for that claim, so exactly one process acts on it. A
   claim that is live, busy, or unreadable is kept, and any failure is swallowed:
   the scan never fails the lock holder. Claim temp files are pruned like lock temp
   files.
5. **PID reuse.** The OS can give the pid of a dead owner to an unrelated process.
   `pidAlive` then reports a live owner, so the lock or claim stays until that
   process exits. This is fail-closed: reuse never reports a running owner as dead,
   so it cannot remove a running process's lock or claim, and a replacement owner
   never matches stale content because every acquisition writes a nonce (#363). The
   window after the liveness query has no recorded reproduction and no unsafe
   outcome. Closing the stuck case needs the owner's start time, a platform-specific
   process-table query. It is recorded as a `known-limit` in `src/lib/runstate.mjs`.

## Consequences

- Orphaned claims, including a claim whose creator crashed inside the
  exclusive-create window, are removed at the next lock acquisition, not only when
  a contender meets the same stale lock.
- A foreign or corrupt unparseable lock with no running writer is now stale at once,
  where it waited 60 s. A lock that cannot be read stays busy until it can be read.
- The guarantees hold only when every contender runs this version or later. An older
  contender takes an unwritten file over after its grace window.
- Windows and POSIX use the same code: `process.kill(pid, 0)` and file names are the
  only OS contracts. No native dependency is added.
- A writer whose temp file an outside process deleted reads as dead. Only this module
  creates and removes those files.

## Alternatives

1. **Heartbeat (the owner touches the file on a timer)**: rejected. A running owner
   that is stalled (a blocked event loop, a suspended laptop) looks dead after the
   timeout, so a running process loses its claim. That is the failure of the grace
   window, moved to a different constant.
2. **OS advisory lock (`flock`, `LockFileEx`)**: rejected. Node has no stdlib
   binding for either, so it needs a native dependency, and the semantics differ
   between Windows and POSIX.
3. **A listening socket or named pipe per owner**: rejected. A Unix socket path has a
   short limit (104 bytes on macOS) that a long temp directory can exceed, and a
   POSIX socket file is itself an orphan after a crash. The two platforms use
   different endpoint kinds.
4. **Pid plus process start time**: rejected for now. It closes the PID-reuse stuck
   case, but needs `ps` and PowerShell queries per platform. It stays the upgrade
   path if reuse is ever observed in practice.
5. **Keep the claim files (the #377 decision)**: rejected. Issue #452 asks for the
   removal, and the writer evidence meets the invariants that blocked it. No ADR
   recorded #377; its reasoning is in PR #445.

## Authors

Andro Marces

## Links

- [Issue #452](https://github.com/andromarces/agent-loops/issues/452)
- [Issue #377](https://github.com/andromarces/agent-loops/issues/377), [PR #445](https://github.com/andromarces/agent-loops/pull/445), [Issue #363](https://github.com/andromarces/agent-loops/issues/363), [PR #370](https://github.com/andromarces/agent-loops/pull/370)
- Implementation: `hasLiveWriter`, `stillStale`, and `pruneOrphanClaims` in
  `src/lib/runstate.mjs`; tests in `tests/lib/runstate.test.mjs`,
  `tests/lib/runstate.stale-takeover.test.mjs`, and
  `tests/lib/runstate.link-fallback.test.mjs`
- [ADR Index](README.md)
