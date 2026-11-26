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

### 1. The batch removes its default root after completed or failed

When a batch reaches completed or failed, its finalization removes the work-tree root only when
both hold:

- The recorded root is the default root derived from the recorded repository and batch id. A
  root the user passed with --work-tree-root is never that root, so it stays empty or not.
- The root is a real, empty directory. A link or any remaining entry keeps it.

A batch in any other final state, such as paused, waiting, interrupted, or a live run, keeps the
root. A manifest field records neither the flag nor the existence of the root, so the decision
reads only the recorded root and the derived default.

A resumed batch is no exception: the default root is derived from the manifest, so a resume that
reaches completed or failed removes the same root, while a root that came from --work-tree-root
stays. A root that the user passed with the same text as the default path is indistinguishable
from the default and follows the default rule.

### 2. The guard is shared with the audit root

The `removeEmptyDirectory` helper in `src/batch/audit-store.mjs` holds the `lstat` and `rmdir`
guard. The audit root removal and the batch finalization both call it, so one implementation and
one set of tests cover a real directory, a link, a remaining entry, and a missing root.

### 3. The path match resolves both spellings of the root

The recorded root and the derived default are canonicalised before they are compared, and the
comparison ignores only case on Windows. A linked parent therefore matches its real form: macOS
temp paths under `/var` resolve to `/private/var`, and a Windows runner temp path under an 8.3
short name resolves to its long form.

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
- A root the user passed stays, whether it is empty or not.
- The audit and the batch share one empty-root guard, so a link-safety fix applies to both.
- A root that a removal cannot delete within the same process is reported and stays; no retry is
  scheduled.

## Alternatives

1. **Remove the root at every final state.** Rejected. A paused, waiting, or interrupted batch
   resumes into the same root, and a live run still writes there.
2. **Record on the manifest whether the root came from the flag.** Rejected. The decision needs no
   field: the default root is derivable from the recorded repository and batch id, so a resume
   keeps the same rule.
3. **Compare the root paths as text.** Rejected. CI reaches the same directory through an 8.3
   short name on Windows and a /var link on macOS, and a text compare would keep the root.
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
