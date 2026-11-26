# 0172. Remove the empty batch work-tree root when a batch ends

## Status

accepted

## Date

2026-11-26

## Context

A batch creates its work-tree root when missing, by default
<repo parent>/<repo name>-batch-<batch id> ([ADR 0106](0106-foreground-batch-scheduling.md)
decision 8). Cleanup removes a succeeded loop's work tree ([ADR 0106](0106-foreground-batch-scheduling.md)
decision 13), but nothing removes the root that held it. After three completed batches the owner
found three empty root directories beside the repository.

The audit path already removes its empty root: decision 5 of
[ADR 0118](0118-remove-a-finished-audit-work-tree-and-store.md) removes the recorded audit root
only when it is a real directory with no entries, with an lstat and rmdir guard that never
follows a link. The batch path has no equivalent.

## Decision

### 1. The batch removes its default root when it moves into completed or failed

When a batch moves into completed or failed, its finalization removes the work-tree root only
when both hold:

- The recorded root is the default root derived from the recorded repository and batch id. A
  root passed with --work-tree-root stays unless its recorded text is that derived path, which
  the rule treats as the default root.
- The root is a real, empty directory. A link or any remaining entry keeps it.

A batch in any other final state, such as paused, waiting, interrupted, or a live run, keeps the
root. A manifest field records neither the flag nor the existence of the root, so the decision
reads only the recorded root and the derived default.

A resumed batch removes the root only when it moves the batch into completed or failed from a
non-terminal state. The default root is derived from the manifest, so such a resume removes the
same root. A resume of a batch that was already completed or failed when it started does not
remove the root, even when that root is empty. A root that came from --work-tree-root stays,
unless its recorded text is the derived default path.

### 2. The guard is shared with the audit root

The `removeEmptyDirectory` helper in `src/batch/audit-store.mjs` holds the `lstat` and `rmdir`
guard. The audit root removal and the batch finalization both call it, so one implementation and
one set of tests cover a real directory, a link, a remaining entry, and a missing root.

### 3. The default root is decided by the recorded path as text

The recorded root and the derived default are compared as text, with the platform case rule
applied, and neither path is resolved through a link. Both paths derive from the recorded
canonical repository and the batch id, so a Windows runner temp path under an 8.3 short name and
a macOS `/var` path need no resolution to match.

The `lstat` guard reads the derived default path itself, so a link at that path is never removed
and its target is never followed. Resolving the paths for the compare would treat a link from the
default path to a user root as proof that the batch used the default, and a resume could delete
the user's directory.

### 4. The removal and a failed removal are logged

A removal logs one batch progress line at info level, the level the audit removal uses. A removal
that fails for a reason other than a missing or non-empty root logs one warning and keeps the
root. A root that still holds an entry is expected, so it logs nothing.

### 5. No other path and no store is removed

The removal deletes no loop work tree, no checkpoint, no claim, no branch, and no store. It is the
last step of finalization, so it never removes a directory that a later step writes to.

## Consequences

- A completed or failed batch that ran on the default root leaves no empty directory beside the
  repository.
- A kept loop work tree keeps the root non-empty, so the root stays with the evidence.
- A root the user passed stays, empty or not, unless its text is the derived default path.
- A link from the derived default path to a user root is not proof of the default root, so the
  user's directory stays.
- A resume of a batch that was already completed or failed does not remove the root.
- The audit and the batch share one empty-root guard, so a link-safety fix applies to both.
- A root that a removal cannot delete within the same process is reported and stays; no retry is
  scheduled.

## Alternatives

1. **Remove the root at every final state.** Rejected. A paused, waiting, or interrupted batch
   resumes into the same root, and a live run still writes there. A resume of a batch that already
   ended must not remove the root.
2. **Record on the manifest whether the root came from the flag.** Rejected. The decision needs no
   field: the default root is derivable from the recorded repository and batch id, so a resume
   keeps the same rule.
3. **Resolve both paths before the compare.** Rejected. A link from the derived default path to a
   --work-tree-root directory then matches the default, and a resume deletes the user's directory.
   Both paths derive from the recorded repository, so a text compare already covers the runner
   short-name and /var forms.
4. **Remove the root in the loop cleanup.** Rejected. The last loop's cleanup cannot know whether
   another loop still uses the root.
5. **Delete the root recursively.** Rejected for the reason of ADR 0106 alternative 8: a link to
   another checkout would be followed and deleted.

## Links

- [Issue #2022: Remove the empty batch work-tree root when a batch ends](https://github.com/andromarces/agent-loops/issues/2022)
- [PR #2027: Remove the empty batch work-tree root when a batch ends](https://github.com/andromarces/agent-loops/pull/2027)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md) (decisions 8 and 13)
- [ADR 0118: Remove a finished audit work tree and store](0118-remove-a-finished-audit-work-tree-and-store.md) (decision 5 is the model)
- Implementation: finalization in `src/batch/supervisor.mjs` and `removeEmptyDirectory` in `src/batch/audit-store.mjs`
- Tests: `tests/batch/supervisor.outcomes.test.mjs` and `tests/batch/audit-store.test.mjs`
- [ADR Index](README.md)
