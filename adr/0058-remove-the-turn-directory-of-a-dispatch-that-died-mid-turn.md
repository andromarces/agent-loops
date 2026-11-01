# 0058. Remove the turn directory of a dispatch that died mid-turn

## Status

partially-superseded

Extends [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md). Decisions 5 and 6 of ADR 0047 remove the directory after the turn, which a dead process never reaches. This ADR adds the removal by a later call. No decision of ADR 0047 is replaced.

Superseded in part by [ADR 0063: Close the limits of the abandoned turn directory removal that the process group and the record origin cover](0063-close-the-limits-of-the-abandoned-turn-directory-removal-that-the-process-group-and-the-record-origin-cover.md):

- Decision 3, the conditions that keep the directory: ADR 0063 adds a live POSIX process group of the child.
- Decision 4, the refusal of a record: ADR 0063 adds a record whose parent is not the inherited temporary directory of the call.
- The consequence "On POSIX only the recorded child is checked": ADR 0063 replaces it.

Decisions 1, 2, and 5, the shape check of decision 4, the other consequences, and both alternatives remain in force.

## Date

2026-10-29

## Context

`withTurnTmpdir` removes the private temporary directory of a turn after the child ends. If the `role dispatch` process dies mid-turn, nothing removes the directory. The run stays `dispatched` with a dead lock owner. The next call marks the run `interrupted`, and `dispatch --resume-interrupted` starts a new turn in a new `al-*` directory. The old directory stays in the inherited temporary directory with no owner (issue #1207).

## Decision

1. **Record before the spawn.** `withTurnTmpdir` takes an `onCreated(record)` callback, awaited after the directory exists and before the child starts. The record holds the path, the real path of the parent, and the device and inode. A role dispatch stores it as `lastDispatch.turnTmpdir` in the state file. The write is a precondition of the spawn. A failed callback starts no child, removes the directory through the ADR 0047 removal, which warns when it refuses or fails, and throws the write error. The dispatch handles that error as it handles any other failure of a turn that is not a cancel, a mutation, or a snapshot error: it records an error result, charges the step, and returns the run to `active`. If the later state write of that result fails too, the call fails with the run left in the durable state of the write before the spawn, `dispatched`, and the next call marks it `interrupted`. This ADR changes neither the step charge nor the lifecycle rules of a failed write before the spawn.
2. **Record the child.** After the CLI starts, `exec` calls `onSpawn(pid)`, and the dispatch adds `child`, the pid and the start-time stamp, to the record. A failed write warns and leaves the record without a child.
3. **Remove on recovery, only when no process of the turn runs.** When a call finds the run `dispatched`, the lock owner is dead. The dispatcher can still have been killed with its child running, as a `SIGKILL` leaves a POSIX child alive. Before it marks the run `interrupted`, the call keeps the directory and warns when the record has no child, when `ownerAlive` (ADR 0020) reads the child as running or cannot read it, or, on Windows, when the process table shows a live process below the recorded pid or cannot be read. The Windows check is needed because a `.cmd` shim ends with its dispatcher while the CLI that it started keeps running. Otherwise the call removes the directory through the removal helper of ADR 0047, with the same device, inode, and parent checks. A directory that is gone, or that something replaced, is not followed.
4. **Only a turn directory.** The state file is editable, so the call refuses a record whose path is not absolute or whose name is not an `al-` name with a six-character `mkdtemp` suffix. A refused record deletes nothing.
5. **Never fails the call.** A kept, refused, or failed removal warns, as in a normal turn, and the call marks the run `interrupted` as before.

## Consequences

- A dispatch killed during a Codex turn leaves no `al-*` directory after the next call on that run, except in the cases below. The removal is conditional: it runs only when the record names a child and no process of the turn may still run, and the ADR 0047 removal can still refuse or fail with a warning.
- The state file of a Codex turn holds a path under the temporary directory of the host.
- A run that no later call touches keeps its directory.
- A dispatch that died before the child pid was recorded, or whose child still runs, keeps the directory with a warning. A person deletes it by hand.
- A later call on an interrupted run re-checks the kept directory and removes it once no process of the turn runs (issue #1329).
- On POSIX only the recorded child is checked. A descendant that outlives a dead child and still uses the directory is not found.
- The limits of ADR 0047 decision 7 and the Windows identity check (issue #709) apply to this removal.

## Alternatives

1. **Remove every `al-*` directory that no live process owns.** Not taken. The prefix alone is not the runtime's own name, because a reviewer can create `al-probe` (ADR 0047).
2. **Remove the directory at process start.** Not taken. A start has no record of which directory belonged to which run.

## Authors

Andro Marces

## Links

- [Issue #1207](https://github.com/andromarces/agent-loops/issues/1207)
- [Issue #1216](https://github.com/andromarces/agent-loops/issues/1216)
- [Issue #1329](https://github.com/andromarces/agent-loops/issues/1329)
- [PR #1230](https://github.com/andromarces/agent-loops/pull/1230)
- [PR #1212](https://github.com/andromarces/agent-loops/pull/1212)
- [ADR 0063: Close the limits of the abandoned turn directory removal that the process group and the record origin cover](0063-close-the-limits-of-the-abandoned-turn-directory-removal-that-the-process-group-and-the-record-origin-cover.md)
- [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- Implementation:
  - Source: `withTurnTmpdir` and `removeAbandonedTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `onSpawn` of `exec` in `src/lib/exec.mjs`, `runCodex` in `src/agents/codex.mjs`, `runChild` in `src/child-turn.mjs`, `recoverLifecycle` in `src/role-dispatch.mjs`
  - Tests: `tests/role.dead-turn-tmpdir.test.mjs`, `tests/lib/turn-tmpdir.test.mjs`, `tests/lib/exec.test.mjs`
  - Docs: `docs/reference/architecture.md`, `docs/reference/role.md`
- [ADR Index](README.md)
