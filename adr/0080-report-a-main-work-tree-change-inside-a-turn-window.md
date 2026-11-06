# 0080. Report a main work tree change that a turn restores inside its window

## Status

accepted

## Date

2026-11-06

## Context

`mainWorkTreeChanged` reads the main work tree before and after a worker turn (ADR 0074, issue #1448). A turn that writes a main work tree file and restores it before the end read leaves no change for that read. Issue #1556 records a turn that restored four files and carried no field. Only the envelopes of concurrent runs named the paths.

## Decision

1. **Turn window.** A worker turn in a linked work tree starts a recursive `fs.watch` of the main work tree before its child call. The watch ends on every outcome: ok, error, cancel, and timeout. The recursive option exists in every Node version that `engines` allows on Windows, macOS, and Linux, so no periodic fallback is used. At the turn end, it closes first and drains the remaining queue, file classification, and settlement under a 1000 ms deadline. A missed deadline reports no field and logs a warning.
2. **Scope.** A candidate path is a tracked file or an untracked file that Git does not ignore. A directory-only event is dropped. The `.git` directory and ignored paths stay out, so an install elsewhere never floods the field.
3. **Confirmation.** A candidate is reported when its state, status and content hash, is the same in the pre-turn and post-turn reads. A path that still differs at the end stays in `mainWorkTreeChanged` only. A candidate whose size and modification time at the turn end equal the values its first in-window read saw is dropped, because a read-only access moves the access time only (issue #1583). NTFS updates an access time older than one hour on a read, and `fs.watch` reports that update as a `change` event, so a read otherwise looks like a restored edit.
4. **Report.** The turn envelope carries the paths as `mainWorkTreeChangedInTurn`, redacted and capped at 20. The field carries no content and no hash.
5. **Failure.** A watch that fails to start, a watch error, or a failed read reports no field and logs a warning. A queue, seen-file, candidate, or read bound that overflows does the same. The pending, seen-file, candidate, and read sets each stop at 500. The docs state that the absent field then proves nothing.
6. **No actor.** The field reports a change observed inside the window. The user or another process can write the same paths.
7. **Both paths.** The field joins `TURN_EVIDENCE`, so the dispatch envelope, `lastResult`, a failed or canceled turn, and the headless result prompt carry it.
8. **Parent action.** The parent reports the field under `open` in the finish summary.

## Consequences

- A restored edit is attributed to that turn, with no concurrent run needed.
- A watch adds one recursive watcher per worker turn, and it closes on every outcome.
- A write and a restore that both land before the watch event is delivered can be missed.
- A writer that keeps rewriting an ignored file cannot extend the turn past the 1000 ms drain deadline.
- A directory created and removed inside the window carries no path.
- A file created and removed before an in-window read sees it stays unseen, so the absent field proves nothing.
- An ignored write in a copied local source stays covered by `localSourceChangedInTurn`, not this field.
- A write of the same bytes can report a path, because the watch sees a filesystem event. The field proves no actor.
- A read-only access names no path, because its size and modification time equal the first in-window read. A turn that only reads the main work tree then carries no field.
- A write that restores the size and the modification time by the turn end is indistinguishable from a read, so it stays out.
- The watch runs one `git check-ignore` call per batch of event paths, so an install elsewhere never reads every path.

## Alternatives

1. **Periodic hashes of the whole main work tree**: rejected. A full tree hash on a timer costs far more than one recursive watch.
2. **Extend `mainWorkTreeChanged`**: rejected. That field reads only at the turn end, so it cannot see a restored edit.
3. **Hash every tracked file before and after**: rejected. It reads a large work tree twice per turn, and it still misses a new untracked path.
4. **Report no field**: rejected. A run with no concurrent run then shows no trace of the edit (issue #1551).

## Authors

Andro Marces

## Links

- [Issue #1556](https://github.com/andromarces/agent-loops/issues/1556)
- [Pull request #1563](https://github.com/andromarces/agent-loops/pull/1563)
- [Issue #1583](https://github.com/andromarces/agent-loops/issues/1583)
- [Issue #1551](https://github.com/andromarces/agent-loops/issues/1551)
- [Issue #1448](https://github.com/andromarces/agent-loops/issues/1448)
- Implementation: `startMainWorkTreeWatch` in `src/lib/main-work-tree-watch.mjs`, `diffMainWorkTreeInTurn` in `src/lib/main-work-tree-change.mjs`, and the evidence field in `src/lib/turn-evidence.mjs`
- Documented in the [orchestrator instructions](../docs/orchestrator-instructions.md) and the headless prompt in `src/prompts/orchestrator.mjs`
- [ADR 0075](0075-report-a-copied-source-that-changed-inside-a-turn-window.md) reports the same window for a copied source
- [ADR Index](README.md)
