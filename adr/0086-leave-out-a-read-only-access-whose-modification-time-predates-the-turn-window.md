# 0086. Leave out a read-only access whose modification time predates the turn window

## Status

accepted

Partially supersedes [ADR 0080: Report a main work tree change that a turn restores inside its window](0080-report-a-main-work-tree-change-inside-a-turn-window.md). It replaces decision 3's confirmation filter, which reports a candidate only by its equal pre-turn and post-turn state, and the consequence that a write and a restore before the event is delivered can be missed.

Decisions 1, 2, and 4 to 8, decision 3's rule that a path which still differs stays in `mainWorkTreeChanged` only, and every other consequence of ADR 0080 remain in force.

## Date

2026-11-07

## Context

ADR 0080 reports a path that a worker turn restores inside its window. Issue #1583 found that a read on Windows also names a path. NTFS updates the last access time of a file on a read when the stored time is more than one hour old. `fs.watch` reports that update as a `change` event, and the pre-turn and post-turn Git state then match, so the path looked like a restored edit.

A baseline taken from the first in-window read does not separate the two. A write and a restore that both land before the first `lstat` make the restored state its own baseline, and a normal restored edit is then dropped.

The modification time separates them. A read leaves it unchanged, and any write sets it to the write time. The turn window start is known before the child call can write, so an end modification time before that start proves no write in the window.

## Decision

1. **Window start.** `startMainWorkTreeWatch` records the wall-clock time when it starts, before the child call can write.
2. **Confirmation.** A candidate is reported when its pre-turn and post-turn state are equal, as ADR 0080 states, and its modification time at the turn end is not earlier than the window start minus a margin. A candidate with an older modification time is a read-only access and is dropped.
3. **Margin.** The margin is 2000 ms. It covers a file system timestamp granularity of up to two seconds and a small clock skew, in the direction that reports a write: a path within the margin stays reported.
4. **Content state.** The pre-turn and post-turn state equality test of ADR 0080 stays.
5. **Limit.** A restore that preserves the old modification time, for example a copy that preserves times, is not reported as an in-window edit.

## Consequences

- On Windows, a read of a main work tree file names no path, so a turn that only reads the main work tree carries no field.
- A normal restored edit is reported on Windows, macOS, and Linux, including when the write and the restore both land before the watch reads the path.
- A file modified within the margin before the window can still be reported. The field proves no actor, so this is a false positive that the parent reports under `open`.
- A restore that preserves the modification time stays out.
- The end `lstat` that the watch already takes supplies the modification time, so the rule reads no file content.

## Authors

Andro Marces

## Links

- [Issue #1583](https://github.com/andromarces/agent-loops/issues/1583)
- [Pull request #1586](https://github.com/andromarces/agent-loops/pull/1586)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md)
- Implementation: `startMainWorkTreeWatch` in `src/lib/main-work-tree-watch.mjs`
- Documented in the [orchestrator instructions](../docs/orchestrator-instructions.md) and the headless prompt in `src/prompts/orchestrator.mjs`
- [ADR Index](README.md)

## Live probe on macOS

On 2026-11-08, a live probe ran on macOS 27.3 (build 26C5035r) with Node v27.0.0-alpha.0.0.0, opencode v0.0.0-dev-973, and agent-loop head e57daf0e2247dd67dc5e297fe6e17ad653398501. A worker turn in a linked work tree restored `file1.txt` by `git checkout` and `file2.txt` by a Vim `:w` save. It rewrote `file3.txt` at the same size, restored its original bytes, and read `file4.txt` with `cat`. The envelope field `mainWorkTreeChangedInTurn` held `["file1.txt","file2.txt","file3.txt"]`, and the envelope carried no `mainWorkTreeChanged` key. Every file ended equal to its start state.
