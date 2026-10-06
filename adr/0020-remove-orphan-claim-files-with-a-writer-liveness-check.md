# 0020. Remove orphan claim files with a writer liveness check

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

1. **Writer marker, then age.** `createLock` already writes a temp file before it
   creates the lock or claim, and removes it after the content is written. Between
   creation and write, that temp file is the only trace of the owner. It is the
   marker `<file>.<pid>.<token>.<n>.tmp`. `hasLiveWriter(file)` is true when a
   marker for `file` has a live pid. An unparseable file with a live marker is
   never taken over, at any age.
2. **Grace path for markerless writers.** A writer of an older version, in the
   exclusive-create fallback, can leave no marker (versions before #176 wrote no
   temp). Its unwritten file cannot be told from a dead one except by age, so an
   unparseable file with no live marker stays protected until it is older than
   `STALE_LOCK_GRACE_MS` (60 s). This is the grace window of the earlier design,
   kept only for the writer that leaves no marker. The pre-guard decision and the
   scan use `ownerless`; the check under the guard uses it too.
3. **Stale means identified dead.** A file is stale when its parsed pid is dead, or
   when it is unparseable, readable, and `ownerless`. A file that cannot be read, or
   that is missing, is kept and the contender exits as busy.
4. **Check under the claim.** Under the guard claim, `stillStale` re-reads the file.
   A parsed owner's content is unique (nonce), so equal content is the same file. An
   unparseable file has no unique content, so the check also compares the file
   identity (inode, size, mtime, ctime, as nanosecond values) before and after the
   reads. A later file at the same path therefore never matches.
5. **Unique marker names.** The marker name carries a token that is unique to the
   process, and a counter that is unique to the call. A later process that reuses a
   pid differs by token, so its marker never has the path of an earlier process's
   marker. The prune of a dead pid's temp files therefore removes only a marker
   with a token: once that process is dead, no other process can write that path.
   The `<pid>.<n>.tmp` name of an older version has no token and is shared by
   every process that reuses the pid, so a pid query cannot prove it orphaned.
   It counts as a marker for liveness and is never removed by this code. An older
   version that crashes leaves one such file, and it stays on disk.
6. **Scan.** After a successful root lock acquisition, `pruneOrphanClaims` lists the
   claims beside the lock and removes each orphan through the existing claimed
   removal. The guard is keyed by the claim's name and content, the same key a
   takeover contender uses for that claim, so exactly one process acts on it. A
   claim that is live, busy, or unreadable is kept, and any failure is swallowed:
   the scan never fails the lock holder. Claim temp files are pruned like lock temp
   files.
7. **PID reuse and owner start time.** The OS can give the pid of a dead owner to an
   unrelated process, and `pidAlive` then reports a live owner. Issue #498 takes the
   upgrade path that this ADR named (Alternative 4), so this decision is amended in
   place: the writer liveness check, the claims, and the invariants of decisions 1 to
   6 do not change, and no new ADR supersedes this one. Each lock and claim records
   a start-time stamp `<kind>:<value>` of the owner (field `startTime`) with its pid.
   `ownerAlive` reads a live pid as dead only when the recorded stamp and the stamp of
   the process now at that pid are of the same kind and differ.
   - Sources, by platform (`processStartTime`). No native dependency is added.
     - Linux, `linux-proc`: field 22 of `/proc/<pid>/stat` (clock ticks since boot)
       with the boot id. No spawn, no timeout, and independent of the wall clock, so a
       clock step (NTP, a manual set, a suspend) never changes it. A stamp of the same
       boot with other ticks, or of another boot, is a different process.
     - macOS, `darwin-lstart`: epoch seconds of `ps -o lstart=` under `TZ=UTC` and
       `LC_ALL=C`, with a 5 s timeout. The line must name a date that exists.
     - Windows, `win32-creation`: epoch seconds of the process creation time from
       `powershell.exe`, with a 5 s timeout.
     - Any other platform has no source and records no stamp.
   - Clock behavior. `ps` on Linux derives `lstart` from the boot time, which moves
     with a wall-clock step, so Linux does not use it. The macOS and Windows kernels
     store the creation time once at process creation, and the tools format it, so a
     clock step afterward should not change it. This comes from the platform
     documentation and source, and no test steps a clock, so it is unverified. The
     kinds `darwin-lstart` and `win32-creation` compare with a 2 s tolerance that
     covers their one-second resolution only, not a clock step.
   - Every other case reads as alive, so an unknown stamp never frees a lock: no
     recorded stamp (a lock of an older version, or the number of an earlier
     revision), a kind mismatch, an unknown kind, and a current read that fails, times
     out, is empty, or does not parse. The decision stays fail-closed.
   - Cost. A contender queries a pid only for a parsed owner with a live pid and a
     recorded stamp. A process reads its own stamp once, on its first lock creation:
     no spawn on Linux, one `ps` on macOS, and one `powershell.exe` startup on
     Windows. The Windows latency is not measured, it is bounded by the 5 s timeout,
     and Node has no cheaper source (`process.uptime()` stops during a system sleep on
     POSIX). It is a `known-limit`.
   - The replacement owner never matches stale content because every acquisition
     writes a nonce (#363). The marker name carries only a pid, so `hasLiveWriter`
     stays pid-only; decision 5 closes the marker race for tokened markers, and an
     older version's marker is never removed.
   - Remaining limits (`known-limit` in `src/lib/runstate.mjs`): the one-second
     resolution on macOS and Windows, a file without a stamp, the unverified
     clock-step behavior on macOS and Windows, and the Windows startup cost.

## Consequences

- A lock acquisition removes an orphaned claim, or a contender that meets its stale
  file does. When, by kind of orphan:
  - A parsed claim whose pid is dead: at the next acquisition.
  - An unparseable claim with no live marker (its writer crashed inside the
    exclusive-create window, or an older version wrote it): at the first
    acquisition after the file is older than the 60 s grace window. A fresh one
    stays until then.
  - An unparseable claim with a live marker, and a claim whose pid and recorded start
    time match a running process: never, while that holds. A reused pid with a
    different start time reads as dead (decision 7). A claim without a start time
    keeps the pid-only check, so a reused pid keeps it until that process exits.
  - A claim that cannot be read: never, until it can be read.
- A foreign or corrupt unparseable lock with no live marker is stale after the 60 s
  grace window. A lock that cannot be read stays busy until it can be read.
- The guarantees hold only when every contender runs this version or later. An older
  contender takes an unwritten file over after its grace window.
- A running writer of an older version that leaves no marker keeps its unwritten file
  only for the grace window. A stall past it loses the file. This is a known limit
  that upgrading every process removes.
- Windows and POSIX use the same code, except the start-time query: `process.kill(pid, 0)`
  and file names are the shared OS contracts, and the start-time stamp uses `/proc` on Linux and `ps` or PowerShell elsewhere (decision
  7). No native dependency is added.
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
4. **Pid plus process start time**: first rejected as the upgrade path to take if reuse
   were ever observed. Issue #498 took it, and decision 7 records the result. Pid alone
   left a lock or claim of a dead owner stuck while an unrelated process held the pid.
5. **Keep the claim files (the #377 decision)**: rejected. Issue #452 asks for the
   removal, and the writer evidence meets the invariants that blocked it. No ADR
   recorded #377; its reasoning is in PR #445.

## Authors

Andro Marces

## Links

- [Issue #452](https://github.com/andromarces/agent-loops/issues/452)
- [Issue #498](https://github.com/andromarces/agent-loops/issues/498): owner start time
- [Issue #377](https://github.com/andromarces/agent-loops/issues/377), [PR #445](https://github.com/andromarces/agent-loops/pull/445), [Issue #363](https://github.com/andromarces/agent-loops/issues/363), [PR #370](https://github.com/andromarces/agent-loops/pull/370)
- Implementation: `hasLiveWriter`, `stillStale`, `pruneOrphanClaims`, `ownerAlive`, and
  `processStartTime` in `src/lib/runstate.mjs`; tests in `tests/lib/runstate.test.mjs`,
  `tests/lib/runstate.stale-takeover.test.mjs`, and
  `tests/lib/runstate.link-fallback.test.mjs`
- [ADR Index](README.md)
