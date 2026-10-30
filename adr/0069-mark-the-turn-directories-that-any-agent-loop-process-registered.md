# 0069. Mark the turn directories that any agent-loop process registered

## Status

accepted

Partially supersedes [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md). This ADR replaces decision 4, which listed every `al-` name of a concurrent process with no mark. Decisions 1 to 3 of ADR 0068 hold.

## Date

2026-10-30

## Context

With several `role` runs at once, a reviewer turn of one run listed the `al-XXXXXX` turn directories of the other runs in `inheritedTmpdirEntries`, with no way to tell them apart (issue #1240). The runtime of each run removes its directory after its own turn, so the entry is never a reviewer leftover, yet the parent carried the names into `open`.

ADR 0068 decision 4 kept every `al-` name of a concurrent process listed, because a reviewer turn can write to the runs root, and a forged record that hides an entry would hide a leftover. Issue #1240 does not approve weakening that guard.

## Decision

1. **Registry.** `withTurnTmpdir` writes one file per turn directory to `<runs root>/turn-tmpdirs/<name>` after the creation. The file holds the device and inode of the directory. The runtime removes the file when the removal of the directory ends, whatever its outcome, as it removes the name from the set of its own process.
2. **Mark, never leave out.** The report lists every entry that appeared. An entry gets the prefix `registered/` when its name has the shape `al-` plus six letters or digits, a registration of it exists, and the entry now has the recorded device and inode. No entry name can hold `/`, so a turn cannot make its own name look marked. The prefix is the only change to `inheritedTmpdirEntries`: no field is added. The runtime still leaves out the exact names that its own process created and has not finished removing, which ADR 0068 decision 4 kept.
3. **The parent reads the mark as a hint.** A `registered/` entry is very likely the turn directory of a concurrent run. The parent may report it under `open` as such, and never treats it as proof.
4. **Failure.** A registry write that fails warns and never fails the turn. The process still leaves out its own names by the exact-name set.

## Consequences

- A reviewer report still lists every entry, as before. The parent can tell the turn directory of a concurrent agent-loop process apart from the rest by its prefix.
- Residual limit: a turn can write to the runs root, so it can forge a registration for a directory that it created. The forgery adds the `registered/` prefix to that entry and never removes the entry, so no turn can hide a leftover. The prefix can mislead the parent about whose directory it is, and that is why the mark is a hint.
- A process that dies before the removal leaves its registration. The file marks only the directory with the recorded identity, so a later directory with the same name is listed without the prefix. The file stays until the host cleans the runs root.
- The directory exists for a short span before its registration, so a report in that span lists it without the prefix.
- The first registry write creates `turn-tmpdirs` in the runs root, which a run has already created.

## Alternatives

1. **Leave out a registered entry.** Not taken. A turn can forge the registration, so it could hide its own leftover, which weakens the guard of ADR 0068 decision 4.
2. **A separate field for the registered entries.** Not taken. It needs the same carry through the envelope, the state file, and the headless event for no gain over a prefix that no entry name can forge.
3. **Keep every `al-` name unmarked.** Not taken. The parent carries names that no reviewer made (issue #1240).
4. **Mark by name only.** Not taken. A registration that outlives its process would mark a reviewer directory that reuses the name. The identity check closes that.

## Authors

Andro Marces

## Links

- [Issue #1240](https://github.com/andromarces/agent-loops/issues/1240)
- [PR #1245](https://github.com/andromarces/agent-loops/pull/1245)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- Related: [ADR 0047](0047-give-each-codex-turn-a-private-temporary-directory.md), [ADR 0049](0049-pin-the-machine-wide-roots-for-every-child-turn.md), [Issue #1024](https://github.com/andromarces/agent-loops/issues/1024), [Issue #1178](https://github.com/andromarces/agent-loops/issues/1178)
- Implementation:
  - Source: `src/lib/turn-tmpdir-registry.mjs`, `withTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `appearedInInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`
  - Docs: `docs/orchestrator/runtime-advisory-fields.md`, `docs/orchestrator-instructions.md`
- [ADR Index](README.md)
