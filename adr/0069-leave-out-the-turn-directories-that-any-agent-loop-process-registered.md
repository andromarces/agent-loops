# 0069. Leave out the turn directories that any agent-loop process registered

## Status

accepted

Partially supersedes [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md). This ADR replaces decision 4, which kept every `al-` name of a concurrent process in `inheritedTmpdirEntries`. Every other decision of ADR 0068 holds.

## Date

2026-10-30

## Context

With several `role` runs at once, a reviewer turn of one run listed the `al-XXXXXX` turn directories of the other runs in `inheritedTmpdirEntries` (issue #1240). The runtime of each run removes its directory after its own turn, so the entry is never a reviewer leftover, yet the parent carried the names into `open`. The report left out only the names that its own process created (ADR 0068, decision 4). ADR 0068 refused a marker in the runs root, because a reviewer turn can write there, and a forged marker would hide a name.

## Decision

1. **Registry.** `withTurnTmpdir` writes one file per turn directory to `<runs root>/turn-tmpdirs/<name>` after the creation. The file holds the device and inode of the directory. The runtime removes the file when the removal of the directory ends, whatever its outcome, as it removes the name from the set of its own process.
2. **Identity, not name.** The report leaves out a name when the name has the shape `al-` plus six letters or digits, a registration of it exists, and the entry now has the recorded device and inode. A name that only matches the pattern, a registration that is missing, unreadable, or malformed, and a replacement directory with the same name are reported.
3. **Failure.** A registry write that fails warns and never fails the turn. The process still leaves out its own names by the exact-name set.

## Consequences

- A reviewer report no longer lists the turn directory of a concurrent agent-loop process on the host.
- A turn can write to the runs root and so can forge a registration. The forgery needs the device and inode of a directory that the turn chose to hide, so it can hide only an entry that the turn made on purpose. The list stays advisory, and the cost of a forgery is one missing name.
- A process that dies before the removal leaves its registration. The file hides only the directory with the recorded identity, so a later directory with the same name is still reported. The file stays until the host cleans the runs root.
- The directory exists for a short span before its registration, so a report in that span lists it.
- The first registry write creates `turn-tmpdirs` in the runs root, which a run has already created.

## Alternatives

1. **Keep every `al-` name reported.** Not taken. The parent carries names that no reviewer made, and the list loses its use (issue #1240).
2. **Hide every name that matches the `al-` pattern.** Not taken. A reviewer can create `al-probe`, and the pattern would hide it.
3. **Register the name only.** Not taken. A registration that outlives its process would hide a reviewer directory that reuses the name. The identity check closes that.

## Authors

Andro Marces

## Links

- [Issue #1240](https://github.com/andromarces/agent-loops/issues/1240)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- Related: [ADR 0047](0047-give-each-codex-turn-a-private-temporary-directory.md), [ADR 0049](0049-pin-the-machine-wide-roots-for-every-child-turn.md), [Issue #1024](https://github.com/andromarces/agent-loops/issues/1024), [Issue #1178](https://github.com/andromarces/agent-loops/issues/1178)
- Implementation:
  - Source: `src/lib/turn-tmpdir-registry.mjs`, `withTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `appearedInInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`
  - Docs: `docs/orchestrator/runtime-advisory-fields.md`
- [ADR Index](README.md)
