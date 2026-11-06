# 0076. Leave out an inherited temporary directory entry that the settle re-read no longer holds

## Status

partially-superseded

Partially superseded by [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md). The superseded parts are:

- Decision 1's rule that the settle re-read is the last filter. Superseded by [ADR 0081](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md).
- The consequence that a longer-lived file still needs an `open` item. Superseded by [ADR 0081](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md).

The settle read, decisions 2 to 6, and the guard stay in force.

Partially supersedes [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md). This ADR replaces decision 2's rule that the report lists every entry that appeared, and the matching consequence. It also qualifies the all-entries rule that ADR 0069 restated from ADR 0068 decision 4.

The mark rule, the exact-name leave-out of this process's own turn directories, and the guard that a record cannot hide a still-existing entry all remain in force.

## Date

2026-11-06

## Context

`inheritedTmpdirEntries` named files that appeared and then disappeared during a turn (issue #1542). In a `role` run of three Codex reviewer turns on Windows, the envelopes carried 3, 5, and 10 entries, all GUID-named `.tmp` files. Shortly after the run, 17 of 18 files no longer existed. None of the names matched a path that a reviewer reported, and none needed action, but the parent had to report each one under `open`.

The runtime reads the directory before and after the turn. A file whose lifetime spans the post-turn read appears in it, even when the file is gone a moment later. ADR 0068 and ADR 0069 deliberately list every entry that appeared, because the reads establish no owner and a record must not hide a leftover.

## Decision

1. **Confirm the appeared entries.** `appearedInInheritedTmpdir` reads the inherited temporary directory again after a short settle and keeps only the names that the second read still holds. A name that is gone by the confirming read is left out.
2. **Persistent entries stay.** Every entry that the confirming read still holds is listed, an `al-` name too, with the `registered/` mark of ADR 0069 unchanged. The exact-name leave-out of the turn directories of this process stays. The guard stays: a registration cannot hide an entry that the confirming read holds.
3. **No owner claim.** The confirming read establishes only that the name is absent. The runtime does not claim that another process created or removed the entry, and the field stays advisory.
4. **A failed confirming read keeps the list.** The names stay listed, because the list is advisory and a lost name would hide a leftover.
5. **Only when a name appeared.** The settle runs only when the post-turn read found a name to confirm, so a turn that leaves no entry waits no longer.
6. **The settle window.** The default wait is 250 ms.

## Consequences

- A file that is created and removed within the settle window no longer reaches the envelope or `open`. A file that lives past the window is still listed, and the reads still cannot attribute it to any process.
- A reviewer turn that leaves a new entry waits a 250 ms settle delay plus the confirming read before its envelope. A turn that leaves none waits no longer.
- The guard of ADR 0069 holds: a still-existing entry cannot be hidden by a registration, and a leftover that stays past the confirming read is listed.
- Residual limit: the window is a fixed wait. A file whose lifetime spans the confirming read is still listed, and a longer-lived file still needs an `open` item.
- Residual limit: a turn that creates and removes an entry within the window leaves no name. The entry is gone, so it needs no action.

## Alternatives

1. **Mark entries that a process other than the turn holds open.** Not taken. The platform does not report a holder reliably on both supported operating systems, and the check needs a process-table read.
2. **State the rule in the orchestrator instructions only.** Not taken. The parent would still carry the names, and the runtime can omit a name that the confirming read no longer holds without any attribution.
3. **Read a second time with no wait.** Not taken. A file that is about to be removed can stay in a second read in the same instant.
4. **Leave out a GUID `.tmp` name by its pattern.** Not taken. The pattern establishes no owner and would hide a `.tmp` entry that a turn left behind.

## Authors

Andro Marces

## Links

- [Issue #1542](https://github.com/andromarces/agent-loops/issues/1542)
- [PR #1547](https://github.com/andromarces/agent-loops/pull/1547)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md)
- Related: [Issue #1024](https://github.com/andromarces/agent-loops/issues/1024)
- Implementation:
  - Source: `appearedInInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`
  - Docs: `docs/orchestrator/runtime-advisory-fields.md`
- [ADR Index](README.md)
