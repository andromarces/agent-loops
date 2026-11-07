# 0088. Recover the killed turn when abort ends a dispatched run

## Status

accepted

Extends [ADR 0058: Remove the turn directory of a dispatch that died mid-turn](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md) and [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md). It adds a caller to the recovery steps and a new append point, and changes neither the removal checks nor the entry shape. No decision is replaced.

## Date

2026-11-07

## Context

A parent can kill a `role dispatch` mid-turn. The run stays `dispatched` with a dead lock owner, its charged turn is missing from `turns`, and its `lastDispatch.turnTmpdir` names a turn directory that nothing removes. The next `dispatch` marks the run `interrupted`, removes the directory, and records the turn. A later call on an `interrupted` run re-checks the kept directory (`src/role/dispatch.mjs`, `withOpenRun` in `src/role/index.mjs`).

`role abort` did neither. It wrote `aborted` and returned, so a parent that aborted instead of dispatching again left the directory in the inherited temporary directory and the turn missing from the history (issue #1591). Every later call refuses the terminal run, so nothing removed the directory later.

## Decision

1. **Recover before ending a dispatched run.** When `role abort` finds the lifecycle `dispatched`, it runs the recovery steps of the interrupted transition before it writes the terminal state: `removeAbandonedTurnTmpdir` on `lastDispatch.turnTmpdir`, and one `turns` entry with status `interrupted`, whose role and time come from `lastDispatch`. The run then ends `aborted` with the reason, as before.
2. **The lock proves the owner is dead.** `abort` runs under the state lock, which refuses a live owner, so the removal acts only on the turn of a dead dispatch.
3. **Keep every removal check.** The removal keeps the directory with the existing warning when the record has no child, when a process of the dead child may still run, when the process group or the Windows process table names one, when the process table cannot be read, or when the record is not the created turn directory under the inherited temporary directory (ADR 0058, ADR 0063). A kept, refused, or failed removal warns and never fails the abort.
4. **No other operation changes.** `extend`, `finish`, `declare-pr`, `refresh-local`, and `set-model` keep their behavior on a `dispatched` run. `recheck-tmpdir` stays a read-only command that deletes nothing (ADR 0085).

## Consequences

- `abort` after a killed dispatch leaves no `al-*` directory after it ends, except in the keep cases of decision 3.
- The aborted run's `turns` holds one `interrupted` entry for the charged turn that the dead dispatch never recorded. The entry shape and the size bound of ADR 0008 hold.
- A run that ends by `abort` no longer needs a later dispatch to clear the directory or the history.
- A kept directory still stays for a person to delete by hand, and a later call cannot remove it because the run is terminal.

## Alternatives

1. **Let `recheck-tmpdir` remove a kept directory of a terminal run.** Not taken. ADR 0085 defines that command as a read that writes and deletes nothing, and the parent may call it after the finish summary. A removal there would change a read command into a mutating one and break that contract.
2. **Wait for a later dispatch to recover the run.** Not taken. A parent that aborts has ended the run on purpose and starts no further dispatch, so the directory would stay.

## Authors

Andro Marces

## Links

- [Issue #1591](https://github.com/andromarces/agent-loops/issues/1591)
- [PR #1594](https://github.com/andromarces/agent-loops/pull/1594)
- [ADR 0058: Remove the turn directory of a dispatch that died mid-turn](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR 0063: Close the limits of the abandoned turn directory removal that the process group and the record origin cover](0063-close-the-limits-of-the-abandoned-turn-directory-removal-that-the-process-group-and-the-record-origin-cover.md)
- [ADR 0085: Let the inherited temporary directory re-check read a terminal run](0085-let-the-tmpdir-re-check-read-a-terminal-run.md)
- Implementation:
  - Source: `abort` in `src/role/index.mjs`; `recordUncertainTurn` in `src/role/dispatch.mjs`
  - Tests: `tests/role.dead-turn-tmpdir.test.mjs`
- [ADR Index](README.md)
