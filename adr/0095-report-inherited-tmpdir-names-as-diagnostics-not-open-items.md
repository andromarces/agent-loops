# 0095. Report inherited temporary directory names as diagnostics, not open items

## Status

accepted

## Supersedes

This ADR supersedes every reporting rule of [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md), [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md), [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md), [ADR 0085: Let the inherited temporary directory re-check read a terminal run](0085-let-the-tmpdir-re-check-read-a-terminal-run.md), and [ADR 0093: Report a held inherited temporary directory name apart from the possible leftovers](0093-report-a-held-inherited-tmpdir-name-apart-from-the-possible-leftovers.md). The superseded parts are:

- ADR 0076 decisions 1 to 6 and every consequence: the settle re-read and its confirming read. The field lists the entries of the one post-turn read.
- ADR 0081 decisions 1 to 8 and every consequence: the recorded name list, `role recheck-tmpdir`, the parent re-check rule, the headless `inheritedTmpdirPresent`, and the `open` rule.
- ADR 0082 decisions 1 to 9 and every consequence: the poll, the 3-minute wait, the fail-closed rules, and the headless wait.
- ADR 0085 decisions 1 to 3 and every consequence: the terminal-run read of the removed command.
- ADR 0093 decisions 1 to 10 and every consequence: the settled field and the Windows and macOS ownership probes.
- [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md), decision 3's sentence that the parent may report a `registered/` name under `open`. The hint itself, the registry, and the failure rule stay in force.

Decisions 1 to 3 of [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md), the private directory, identity, and cleanup decisions of [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md), and the abandoned-dispatch recovery of ADR 0058, ADR 0063, and ADR 0088 stay in force.

## Date

2026-11-07

## Context

Five ADRs in two days adjusted the inherited temporary directory report after a noise report: ADR 0076 added a 250 ms settle re-read, ADR 0081 a re-check before the finish summary, ADR 0082 a 3-minute wait, ADR 0085 a terminal-run read, and ADR 0093 an ownership probe with a separate settled field (issues #1542, #1559, #1569, #1575, and #1600).

The observed names were mostly GUID `.tmp` files and macOS `-shm` and `-wal` pairs, and they needed no action. The reporting contract made each name an automatic `open` item, so every reviewer turn could add work that no one could resolve. The field was already advisory: no finish was refused for a name (ADR 0081, ADR 0085).

The evidence shows recurring noise. It does not prove that every recent entry was OS noise. A disappearance or an open handle does not establish a creator either. The ADR therefore changes the reporting contract, not the safety work and not the detector's claim.

## Decision

1. **Diagnostics, not open items.** A reviewer envelope keeps `inheritedTmpdirEntries`. The runtime reads the inherited temporary directory once after the last child call of the dispatch, and lists every entry that appeared and is not this process's own turn directory, redacted and capped at 20. There is no settle re-read and no wait. It is a diagnostic: the reads establish no owner, an unattributed difference creates no automatic `open` item, and no finish is refused for a name (issue #1616).
2. **Actionable cases stay actionable.** An entry that a turn explicitly reports as its own leftover stays actionable: the parent reports it under `open` and names the turn report. A cleanup failure that the runtime observes stays actionable too: the existing `warn` line in `removeTurnTmpdir` names the directory that the runtime did not remove and says to delete it by hand. The line is the record and the operator's action; the runtime adds no envelope field for it.
3. **Keep the safety work.** Private turn directories for every adapter, the device and inode identity checks, the cleanup helper and its bound, `CLAUDE_CODE_TMPDIR` preservation, and abandoned-dispatch recovery do not change (ADR 0047, ADR 0058, ADR 0063, ADR 0068, ADR 0088).
4. **Remove the filters.** Remove `role recheck-tmpdir`, `presentInheritedTmpdir`, `presentInheritedTmpdirReport`, `settleInheritedTmpdirNames`, the Windows held-open probe, the macOS pid and sibling probe, the ancestor read, the `inheritedTmpdirSettled` envelope field, the headless `inheritedTmpdirPresent`, and the state field `inheritedTmpdirNames`. Each existed only to filter or explain the automatic `open` list. No wait and no ownership probe for that purpose remains.
5. **Keep the `registered/` hint.** The mark stays in `inheritedTmpdirEntries`. It tells the parent that a name is most likely the turn directory of a concurrent agent-loop process, adds no wait, and filters nothing. The parent creates no item from it by itself, so a forged registration can mislead only the hint and cannot hide an entry.
6. **State the detection limits.** The field cannot establish a creator, a holder, or a purpose. A name can belong to the OS, the user, another run, or the reviewer. A private directory that could not be created falls back to the inherited one, and a cleanup can fail. A write by the reviewer's command through `CLAUDE_CODE_TMPDIR`, or with an absolute path, does not use the private directory. An entry created after the post-turn read stays unseen, and a turn that crashes or is killed carries no field.

## Open decisions

1. **`role recheck-tmpdir` and `inheritedTmpdirPresent` stay or go.** They go. Their only purpose was to keep a name out of the automatic `open` item. A read without a wait would still add a subcommand, a stored name list, a headless field, and docs for a diagnostic that the envelope already carries, and it would still establish no creator.
2. **Where a directly observed cleanup failure appears.** The existing `warn` line in `removeTurnTmpdir` stays. It already fires for every failed, refused, timed-out, or killed removal, names the directory, and gives the one action: delete it by hand. A new envelope field would touch every dispatch and finish path for a rare event that no finish rule reads.
3. **Supersede all of ADR 0085 or only its restatement of ADR 0082.** All of ADR 0085. It adjusts only `role recheck-tmpdir`, which this ADR removes. Keeping the restatement would leave an ADR that points to a command that no longer exists.
4. **Keep the `registered/` hint of ADR 0069.** Keep it. It is a label on the same diagnostic field, costs no wait, and helps the parent and the user read a concurrent run's name. No finish rule reads it.

## Consequences

- An unattributed directory difference no longer creates an `open` item, and the finish summary needs no action for it.
- No run waits 250 ms or 3 minutes, and no run reads the process table or opens a file to classify an entry.
- A reviewer turn that leaves a real leftover still shows its name in the envelope. The user can act on it, and a turn that reports its own leftover makes it actionable.
- A cleanup failure still warns with the directory and the manual action.
- A held-open Windows file and a live macOS pid no longer settle a name, because the settled field is gone. Their names stay in the diagnostic list.
- The state file no longer grows with reviewer-reported names.
- Residual limit: a name created and removed around the post-turn read can stay unseen or appear once. No read can prove a later state.
- Residual limit: the field still names OS and concurrent-process entries. That noise is expected and costs no action.

## Alternatives

1. **Keep `role recheck-tmpdir` with no wait.** Not taken. A diagnostic read adds a command, a state field, a headless field, and docs for a value that the envelope already carries, and still cannot attribute a name.
2. **Add an envelope field for a cleanup failure.** Not taken. The existing `warn` line already names the directory and the action, and no finish rule can act on the field.
3. **Remove the `registered/` hint.** Not taken. It is free at the one read and helps a reader tell a concurrent run's name apart. It filters nothing.
4. **Filter by a name pattern or a name that a turn referenced.** Not taken. A pattern and a mention establish no owner, and an unreported write would escape the filter.

## Authors

Andro Marces

## Links

- [Issue #1616](https://github.com/andromarces/agent-loops/issues/1616)
- [PR #1617](https://github.com/andromarces/agent-loops/pull/1617)
- Related issues: #1542, #1559, #1569, #1575, #1600
- [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md)
- [ADR 0076: Leave out an inherited temporary directory entry that the settle re-read no longer holds](0076-leave-out-an-inherited-tmpdir-entry-that-the-settle-re-read-no-longer-holds.md)
- [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md)
- [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md)
- [ADR 0085: Let the inherited temporary directory re-check read a terminal run](0085-let-the-tmpdir-re-check-read-a-terminal-run.md)
- [ADR 0093: Report a held inherited temporary directory name apart from the possible leftovers](0093-report-a-held-inherited-tmpdir-name-apart-from-the-possible-leftovers.md)
- Implementation:
  - Source: `appearedInInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`, `src/role/dispatch.mjs`, `src/runtime.mjs`, `src/prompts/orchestrator.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/role.dispatch.reports.test.mjs`, `tests/runtime.inherited-tmpdir.test.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/runtime-advisory-fields.md`, `docs/reference/role.md`
- [ADR Index](README.md)
