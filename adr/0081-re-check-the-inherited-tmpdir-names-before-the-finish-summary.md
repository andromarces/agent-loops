# 0081. Re-check the inherited temporary directory names before the finish summary

## Status

partially-superseded

Partially supersedes [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md). It replaces decision 1's rule that the settle re-read is the last filter. It also replaces the consequence that a longer-lived file still needs an `open` item.

[ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md) replaces decision 2's single read. It also replaces decision 8's single re-read after a reviewer turn and the consequence that the re-check makes no claim about a later state.

Partially superseded by [ADR 0085: Let the inherited temporary directory re-check read a terminal run](0085-let-the-tmpdir-re-check-read-a-terminal-run.md). It replaces decision 3's requirement that the run is non-terminal.

The settle read, decision 1, decisions 4 to 7, decision 3's remaining parent-only and parent-session rules, and every other consequence of ADR 0076 and ADR 0081 remain in force.

## Date

2026-11-06

## Context

`inheritedTmpdirEntries` named GUID `.tmp` files that lived for seconds or minutes (issue #1559). The 250 ms settle of ADR 0076 saw them, so every envelope held them. The parent reported each name under `open`, and none needed action. Eight sampled names were gone 30 to 90 minutes after the run.

The parent writes the finish summary before it calls `finish`. The `finish` envelope therefore cannot supply a later read. The parent role allows only listed status reads, so a doc-only rule gives it no way to check a name. A headless orchestrator cannot run a `role` command at all, so its runtime must supply the read result.

A finish must not inspect the summary prose for these names. A name can appear in a sentence that does not report it, and a refused finish spends a corrective turn. The parent rule alone decides what reaches `open`.

The runtime can keep the names that the reviewer turns reported. A later read can then check those exact names. The directory entry is the only fact the read needs, and the read needs no owner.

## Decision

1. **Keep the reported names.** The dispatch appends the `inheritedTmpdirEntries` of each reviewer turn to `state.inheritedTmpdirNames`. The union is deduped, so several turns that report one name keep one entry. A worker turn records nothing.
2. **Read at a later point.** `agent-loop role recheck-tmpdir` is a read-only parent subcommand. It re-reads the inherited temporary directory and returns the recorded names that are present at that moment. It writes no run state, takes no state lock, deletes nothing, moves nothing, follows no link, and reports names only.
3. **Accept the parent only.** The command reads a non-terminal run from the state file that init wrote. It requires the stored `--parent-session` id, as `extend` does. A missing id and a different id are refused, and a child role is refused for the same reason.
4. **Include a legacy state.** A state file written before `inheritedTmpdirNames` existed contributes the names in `lastResult`. A dispatch carries them into the new field before it replaces `lastResult`. A run that predates the field still reports them.
5. **Fail closed.** A failed or over-bound read keeps every recorded name. So does a name that the read cannot check: a redacted name, a Windows drive, backslash, or UNC form, a path separator, and `..`. A name that another process created again counts as present, because the read holds it.
6. **Bound the report.** The re-read lists at most 20 names, redacted at the reporting boundary like the envelope field (ADR 0017). It compares names, so a recorded name never resolves a path.
7. **Parent rule only.** Before the finish summary, the parent runs the command and carries into `open` only the names it returns. Neither `role finish` nor the headless finish inspects the summary for a name. The parent still never deletes an entry, and a `registered/` name stays a hint and not proof.
8. **Headless path.** The runtime keeps the names and re-reads them after each reviewer turn. It adds `inheritedTmpdirPresent` to the result prompt, with the names present at the read, redacted and capped at 20. The prompt states the same `open` rule.

A subcommand is the smallest shape here. The parent can run it right before the summary, and no existing envelope changes its meaning.

## Consequences

- A GUID `.tmp` file that is gone by the re-check stays out of `open` when the parent follows the rule.
- The re-check reports the names still present at the moment of its read. It makes no claim about a later state.
- The parent runs one extra command per run that received the field.
- A name removed after the re-check still reaches the summary, because no read can catch a later removal.
- A redacted or unsafe name always reaches `open`, because the read cannot prove it gone.
- A parent that ignores the rule can still report a gone name. No finish refuses that report.
- The state grows by at most 20 names per reviewer turn, and a report keeps the first 20 present names.

## Alternatives

1. **State the rule in the orchestrator instructions only.** Not taken. The parent holds no read of its own, and the headless parent cannot run one.
2. **Leave out a GUID `.tmp` name by its pattern.** Not taken. The pattern establishes no owner and can hide a `.tmp` entry that a turn left behind.
3. **Add the read to the `finish` envelope.** Not taken. The parent writes the summary before that call, so the read arrives too late.
4. **Refuse a finish that lists a gone name.** Not taken. The finish inspects prose, and a sentence that mentions a name is not an `open` item.
5. **Re-read through a later dispatch envelope.** Not taken. The last reviewer turn has no later dispatch before the finish.
6. **Wait longer in the settle.** Not taken. The wait is an arbitrary bound, and a GUID file can live for minutes.

## Authors

Andro Marces

## Links

- [Issue #1559](https://github.com/andromarces/agent-loops/issues/1559)
- [PR #1564](https://github.com/andromarces/agent-loops/pull/1564)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md)
- [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md)
- Implementation:
  - Runtime: `presentInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Parent read: `recheck-tmpdir` in `src/role/index.mjs`
  - State: `recordInheritedTmpdirNames` in `src/role/dispatch.mjs`
  - Headless prompt: `inheritedTmpdirPresent` in `src/runtime.mjs` and `src/prompts/orchestrator.mjs`
  - Docs: `docs/orchestrator/runtime-advisory-fields.md` and `docs/orchestrator-instructions.md`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.recheck-tmpdir.test.mjs`, and `tests/runtime.inherited-tmpdir.test.mjs`
- [ADR Index](README.md)
