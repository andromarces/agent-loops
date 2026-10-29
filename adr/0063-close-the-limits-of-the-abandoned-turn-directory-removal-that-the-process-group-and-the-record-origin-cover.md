# 0063. Close the limits of the abandoned turn directory removal that the process group and the record origin cover

## Status

accepted

Partially supersedes [ADR 0058: Remove the turn directory of a dispatch that died mid-turn](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md). This ADR replaces the keep conditions of decision 3, the refusal set of decision 4, and the consequence "On POSIX only the recorded child is checked". Decisions 1, 2, and 5 of ADR 0058 hold, with the addition of decision 3 below.

## Date

2026-10-29

## Context

ADR 0058 removes the turn directory of a dispatch that died mid-turn, and records four limits (issue #1216). `exec` starts every CLI with execa `killDescendants: true`. On POSIX, execa then spawns the child with `detached: true`, so the child leads its own process group and the group id is the child pid. The group id stays reserved while any member runs, so the group still names a descendant that was reparented after the child died. The ADR 0058 reason against a group check, that it needs a signal-handling change, does not hold: the group already exists and no spawn option changes.

## Decision

1. **POSIX process group.** Before the removal, a POSIX call sends signal 0 to the group of the recorded child. A group with a live member, or an error other than `ESRCH`, keeps the directory with a warning. This is an added keep condition of decision 3 of ADR 0058. The Windows process-table check is unchanged.
2. **Record origin.** The call refuses a record whose `parentReal` is not the real path of the temporary directory that the call inherited, because a turn directory is created there only. An `al-` directory elsewhere with its real device and inode is not removed. A call that runs with another temporary directory than the dispatch that died keeps the directory with a warning. This is an added refusal of decision 4 of ADR 0058.
3. **Stale record.** The dispatch clears `lastDispatch.turnTmpdir` in memory when its record write fails, so the later write of the error result saves no record of a directory that is already removed.
4. **Unrecorded child stays.** A dispatch that died between the spawn and the write of the child pid keeps its directory, and no later sweep removes it. The record holds no pid in that window, so no group id is known, and a removal by age or by name alone can delete a directory that a live child uses (ADR 0058 alternative 1).

## Consequences

- A descendant that outlives a dead child in its group keeps the directory until the group ends.
- A group id that the OS reused for a new group after the old one ended keeps the directory, with a warning. The cost is a leaked directory, never a wrong removal.
- A descendant that leaves the group of the child, with `setsid` for example, is not found.
- The group check runs on POSIX only. Its live check is open on issue #707 (Linux) and issue #708 (macOS).
- The dispatch that died in the unrecorded window leaves its directory for a person to delete by hand.

## Alternatives

1. **Sweep a kept directory when no process of the turn can be found**: not taken. Without a recorded pid there is no process to find (decision 4).
2. **Compare the record against the tracked set of turn directory names of the process**: not taken. A recovery call runs in a new process with an empty set.

## Authors

Andro Marces

## Links

- [Issue #1216](https://github.com/andromarces/agent-loops/issues/1216)
- [PR #1230](https://github.com/andromarces/agent-loops/pull/1230)
- Supersedes (partially): [ADR 0058](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md)
- Related: [ADR 0047](0047-give-each-codex-turn-a-private-temporary-directory.md), [ADR 0020](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- Implementation:
  - Source: `removeAbandonedTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `onTurnTmpdir` in `src/role-dispatch.mjs`, `killDescendants` in `exec` of `src/lib/exec.mjs`
  - Tests: `tests/lib/turn-tmpdir.test.mjs`, `tests/role.dead-turn-tmpdir.test.mjs`
  - Docs: `docs/reference/architecture.md`
- [ADR Index](README.md)
