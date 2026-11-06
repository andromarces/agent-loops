# 0081. Re-check the inherited temporary directory names before the finish summary

## Status

accepted

Partially supersedes [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md). This ADR replaces decision 1's rule that the settle re-read is the last filter. It also replaces the consequence that a longer-lived file still needs an `open` item.

The settle read stays. Decisions 2 to 6 of ADR 0076, and every consequence about the settle itself, remain in force.

## Date

2026-11-06

## Context

`inheritedTmpdirEntries` named GUID `.tmp` files that lived for seconds or minutes (issue #1559). The 250 ms settle of ADR 0076 saw them, so every envelope held them. The parent reported each name under `open`, and none needed action. Eight sampled names were gone 30 to 90 minutes after the run.

The parent writes the finish summary before it calls `finish`. The `finish` envelope therefore cannot supply a later read. The parent role allows only listed status reads, so a doc-only rule gives it no way to check a name. A name can also be removed after the reviewer turn and before the summary, so the check must run at the parent.

The runtime can keep the names that the reviewer turns reported. A later read can then check those exact names. The directory entry is the only fact the read needs, and the read needs no owner.

## Decision

1. **Keep the reported names.** The dispatch appends the `inheritedTmpdirEntries` of each reviewer turn to `state.inheritedTmpdirNames`. The union is deduped, so several turns that report one name keep one entry. A worker turn records nothing.
2. **Re-read at a later point.** `agent-loop role recheck-tmpdir` is a read-only parent subcommand. It re-reads the inherited temporary directory and returns the recorded names that still exist. It writes no state, deletes nothing, follows no link, and reports names only.
3. **Fail closed.** A failed or over-bound read keeps every recorded name. So does a name that the read cannot check: a redacted name, one with a path separator, and `..`. A name that another process created again counts as present, because the read holds it.
4. **Bound the report.** The re-read lists at most 20 names, redacted at the reporting boundary like the envelope field (ADR 0017). It compares names, so a recorded name never resolves a path.
5. **Parent rule.** Before the finish summary, the parent runs the command and carries into `open` only the names it returns. The parent still never deletes an entry, and a `registered/` name stays a hint and not proof.
6. **Refuse a child.** A child role of the run is refused, as `extend` refuses one, because the read answers the parent only.
7. **Headless path.** The runtime keeps the names in memory and re-reads them when it evaluates a finish. It refuses a finish whose `open` lists a name that the re-read no longer holds. That refusal needs no child turn, like the unresolved-compare marker.

A subcommand is the smallest shape here. The parent can run it right before the summary, and no existing envelope changes its meaning.

## Consequences

- A GUID `.tmp` file that is gone by the re-check no longer reaches the finish summary as an `open` item.
- The re-check runs a parent turn after the reviewer turn, so a file that lives for seconds fails it.
- The parent runs one extra read-only command per run that received the field.
- A name removed after the re-check still reaches the summary, because no read can catch a later removal.
- A redacted or unsafe name always reaches `open`, because the read cannot prove it gone.
- The state grows by at most 20 names per reviewer turn, and a report keeps the first 20 present names.

## Alternatives

1. **State the rule in the orchestrator instructions only.** Not taken. The parent holds no read of its own, and the runtime cannot omit a name that a later read no longer holds without one.
2. **Leave out a GUID `.tmp` name by its pattern.** Not taken. The pattern establishes no owner and can hide a `.tmp` entry that a turn left behind.
3. **Add the read to the `finish` envelope.** Not taken. The parent writes the summary before that call, so the read arrives too late.
4. **Re-read through a later dispatch envelope.** Not taken. The last reviewer turn has no later dispatch before the finish.
5. **Wait longer in the settle.** Not taken. The wait is an arbitrary bound, and a GUID file can live for minutes.

## Authors

Andro Marces

## Links

- [Issue #1559](https://github.com/andromarces/agent-loops/issues/1559)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md)
- [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md)
- Implementation:
  - Runtime: `presentInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Parent read: `recheck-tmpdir` in `src/role/index.mjs`
  - State: `recordInheritedTmpdirNames` in `src/role/dispatch.mjs`
  - Headless finish: `goneInheritedTmpdirNames` in `src/finish-gate.mjs`
  - Docs: `docs/orchestrator/runtime-advisory-fields.md` and `docs/orchestrator-instructions.md`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.recheck-tmpdir.test.mjs`, and `tests/runtime.inherited-tmpdir.test.mjs`
- [ADR Index](README.md)
