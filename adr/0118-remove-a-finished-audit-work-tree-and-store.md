# 0118. Remove a finished audit work tree and store

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md).
These parts are replaced:

- Owner decision 2, "Keep the audit work tree. No cleanup rule is added in milestone 2."
- The decision 3 sentence "The work tree is kept for inspection; this milestone adds no removal
  rule."
- The decision 10 deletion clause "never deletes an audit or its work tree."
- The decision 13 entry "Removal of the audit work tree or its store."
- The consequence sentence "The audit work tree stays on disk for inspection, so each run costs
  one checkout until the owner removes it."

Every other decision, consequence, and acceptance check of ADR 0109 stays in force.

## Date

2026-11-09

## Context

`agent-loop batch audit` keeps one detached work tree at the audited revision and one store under
`<runs root>/batches/audits/<audit id>.json` after the run ends. ADR 0109 decision 13 deferred
the removal and owner decision 2 added no cleanup rule, so each audit costs one checkout until
the owner removes it by hand. No command removes a finished audit.

The batch already removes only a proved-pushed success ([ADR 0106](0106-foreground-batch-scheduling.md)
decision 13): it checks the recorded path, the registered work tree, the identity, the
cleanliness, and the locks, then runs `git worktree remove --force` and a link-safe remainder
delete. That decision stays in force and is the model for this removal. An audit has no branch
and no push to prove, but its frozen revision and frozen issue set are the evidence that the
work is finished.

## Decision

### 1. One foreground command removes one audit

`agent-loop batch audit remove --audit <id>` removes one audit. It takes the audit lock of
ADR 0109 decision 9, reads the store, writes progress on stderr, and prints one JSON summary on
stdout. There is no daemon and no process that outlives the command.

The exit code is 0 when the work tree and store are removed, 1 when the audit is kept and the
summary names the reason, including a malformed store, a failed removal, or a held audit lock,
and 2 for a missing or unknown audit id, before any removal. A command that cannot take the audit
lock reports `locked`, removes nothing, and exits 1. A SIGINT ends the process with exit 130; the
next `remove` re-reads the store and removes what remains. The store goes last, so an interrupted
removal leaves a record that a retry can finish.

### 2. Only a finished audit is removable

The command removes a work tree and store only when all of these hold:

- The status is `created`.
- The frozen issue set exists as an array. An empty array is a finished set.
- `pendingCreate` is null. An unreconciled issue write keeps both, because the store holds the
  stable identity that reconciles the write.

A `running`, `paused`, `needs-owner`, `interrupted`, or unknown status keeps the work tree and
the store, and the summary names the state. A failed audit can therefore still be retried,
approved, or inspected, and a `needs-owner` audit still holds the evidence that the checkout
drifted.

### 3. Removal checks the recorded work tree

Before any delete the command applies the checks of ADR 0106 decision 13 to the audit work tree:

- The path equals the recorded path, its canonical path equals the recorded canonical path, and
  it lies under the recorded audit work tree root.
- It is not the main work tree.
- Its device and inode still match the record.
- `git worktree list --porcelain` names it exactly once for the repository, and it is not locked
  by a live run.
- Its HEAD is the frozen revision and `git status --porcelain` is empty.

A failed check keeps both artifacts and reports the reason. A work tree that is already missing
still passes the registration and lock checks: a remaining registration, and above all a locked
one, keeps both artifacts and reports it; when Git no longer registers the path, the command
removes the store alone.

### 4. The delete follows no link or junction

The command runs `git worktree remove --force "<work tree>"`. When a directory remains, it uses
the link-safe remainder procedure of ADR 0106 decision 13: inspect every entry first, refuse on
a real file, unlink a link without following it, delete only directories, and re-check the root
identity before and during the delete. A symbolic link or junction that names a path outside the
work tree is removed as an entry, and its target is never read or deleted.

### 5. The store and the audit root go last

After the work tree is gone, the command removes the store file. It then removes the recorded
audit root only when the root is the recorded parent, is a real directory, and is empty; `rmdir`
does not follow a link, and a remaining entry or a link keeps the root. A failed store removal
leaves the record and exits 1, and the next `remove` retries it. Nothing else is deleted: the
runs root, another audit, the batch stores, and the claims stay.

### 6. No remote write and no claim

An audit has no claim, branch, commit, or pull request, so the command writes nothing to GitHub
and releases no claim. It deletes no branch, tag, or remote ref.

### 7. Documentation

The implementation adds:

- The `agent-loop batch audit remove` line and the removal rule to the `Reviewer audits`
  section of `docs/reference/batch.md`.
- A removal rule to `docs/orchestrator-instructions.md`: the skill runs
  `agent-loop batch audit remove` when the user asks to remove a finished audit, and deletes no
  audit folder or store by hand.
- The `agent-loop batch audit remove` line in `help.mjs`, with its refusals and exit codes.

### 8. Acceptance checks

1. A `created` audit with a frozen issue set is removed, and its work tree folder, audit root, and
   store no longer exist.
2. A `paused` or `needs-owner` audit keeps its work tree and store.
3. A `created` audit with a non-null `pendingCreate` keeps both.
4. A link or junction inside the work tree that names a path outside it leaves the target intact.
5. A recorded path whose identity, registration, revision, or cleanliness does not match keeps
   both artifacts and reports the reason, including a missing folder that Git still registers or
   locks.
6. `remove` without `--audit` or with an unknown id exits 2 and removes nothing. A malformed
   store exits 1 and removes nothing.

## Consequences

- A finished audit costs no checkout after the owner runs one command, and the store goes with
  it, so nothing from that audit remains to resume or inspect.
- A paused, `needs-owner`, interrupted, or unreconciled audit keeps its evidence, so the retry,
  approval, and reconciliation paths of ADR 0109 still work.
- The store is the last thing removed, so a failed or interrupted removal is retryable and never
  leaves an audit record that names a missing work tree as if the audit completed.
- The delete uses the same link-safe procedure as the batch cleanup, so the Windows junction case
  has one implementation and one set of tests.
- The owner can no longer inspect a removed audit. The decision to remove is deliberate, and the
  frozen issue set stays in GitHub.

## Alternatives

1. **Remove automatically at the end of `start`, `resume`, or `approve`.** Rejected. The owner
   loses the checkout and the store before reading the summary, and a mistaken audit cannot be
   inspected.
2. **Remove the store before the work tree.** Rejected. A failed work-tree delete would leave a
   tree that no record names, and a retry could remove the wrong path.
3. **Remove a paused or `needs-owner` audit.** Rejected. The retry and reconciliation paths need
   the saved results and the checkout evidence.
4. **Remove a finished audit with `pendingCreate` set.** Rejected. The store holds the identity
   that proves whether the issue write landed, so removing it could create a duplicate.
5. **Delete the folder with a recursive delete that follows links.** Rejected for the reason of
   ADR 0106 alternative 8: a junction into the shared package store would delete another
   checkout.
6. **Keep the store after removing the work tree.** Rejected. A record that names a missing work
   tree on a `created` audit is a false success, and the issue set is already in GitHub.

## Links

- [Issue #1733: Remove a finished batch audit work tree and store](https://github.com/andromarces/agent-loops/issues/1733)
- [PR #1747: Remove a finished batch audit work tree and store](https://github.com/andromarces/agent-loops/pull/1747)
- [Implementation: audit supervisor](../src/batch/audit.mjs)
- [Implementation: audit store](../src/batch/audit-store.mjs)
- [Implementation: batch command](../src/batch/cli.mjs)
- [Tests: audit coordination](../tests/batch/audit.test.mjs)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md) (decision 13 is the model)
- [ADR 0109: Coordinate reviewer audits and consolidated issue creation](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md) (owner decision 2 partially superseded)
- [ADR Index](README.md)
