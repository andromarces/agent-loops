# 0073. Lock the work tree of an active run

## Status

accepted

## Date

2026-11-02

## Context

Issue #1347 records an outside session that removed the linked work tree of an active run, then re-created it by hand. The run state was untouched, and the worker turn still finished `ok`. The ignored files that init copied were gone, and the runtime reported only `localFilesDiffer`. ADR 0018 defines that copy at init. `docs/orchestrator/work-tree-removal.md` removes a terminal work tree with `git worktree remove --force`.

Git already offers a lock on a linked work tree. A lock makes `git worktree remove`, a single `--force`, and `git worktree prune` refuse the path. Only a double `--force` of `git worktree remove` removes a locked work tree.

Issue #1351 records that the removal doc forbids a manual unlock, so a terminal run that kept its lock had no permitted path.

## Decision

1. `role dispatch` takes a Git work tree lock at init when `--cwd` is a linked work tree. The reason is `agent-loop run <id> active`, and the id is the run state directory name.
2. Init in the main work tree takes no lock and logs a line. Git refuses to lock the main work tree.
3. Init keeps a lock that another owner made, whatever its reason. An unlock runs only when the lock reason equals this run's reason.
4. A terminal lifecycle unlocks the work tree: `finished`, `aborted`, and `halted`. An `active`, `dispatched`, or `interrupted` run keeps the lock.
5. A failed lock or unlock logs a warning and changes no command outcome. Init, finish, abort, and the halt path still run.
6. The removal step needs no change. A terminal run has unlocked the work tree, so `git worktree remove --force` succeeds.
7. The headless `agent-loop` command takes no lock. It keeps no run state file and has no terminal command.
8. The lock protects against removal by another process. It never blocks a write inside the work tree.

## Consequences

- A `git worktree remove --force` of an active run refuses with `cannot remove a locked working tree`, and names the run reason. A `git worktree prune` leaves the work tree alone.
- The documented removal step works after `finished`, `aborted`, and `halted`.
- A crash between the terminal state write and the unlock leaves a lock on a terminal run. The next `finish` or `abort` of that terminal run unlocks it, because its reason names the run. The removal step then succeeds.
- Init over that terminal state keeps the lock, because the reason matches. The new run unlocks it at its own terminal lifecycle.
- A process with write access to the main Git directory can still remove the lock. A double `--force` also removes it.
- The lock is not verified on Windows in this change.

## Alternatives

1. **Detect a re-created work tree at dispatch**: rejected as the only measure. It reports the change after edits are lost, and it adds an identity record to every dispatch.
2. **Lock from the parent instructions**: rejected. A step that the parent runs by hand is not a runtime guarantee.
3. **Lock the main work tree too**: rejected. Git refuses it, so init takes no lock there.
4. **Refuse a dispatch on a work tree lock that this run does not hold**: rejected. It turns another tool's lock into a blocked run.

## Authors

- andromarces

## Links

- [Issue #1347](https://github.com/andromarces/agent-loops/issues/1347)
- [Issue #1351](https://github.com/andromarces/agent-loops/issues/1351)
- [PR #1349](https://github.com/andromarces/agent-loops/pull/1349)
- [ADR 0018](0018-copy-local-files-into-a-linked-run-work-tree.md)
- [Removing a work tree](../docs/orchestrator/work-tree-removal.md)
- [Role reference](../docs/reference/role.md)
- [`src/lib/work-tree-lock.mjs`](../src/lib/work-tree-lock.mjs)
