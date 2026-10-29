# 0058. Remove the turn directory of a dispatch that died mid-turn

## Status

accepted

Extends [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md). Decisions 5 and 6 of ADR 0047 remove the directory after the turn, which a dead process never reaches. This ADR adds the removal by a later call. No decision of ADR 0047 is replaced.

## Date

2026-10-29

## Context

`withTurnTmpdir` removes the private temporary directory of a turn after the child ends. If the `role dispatch` process dies mid-turn, nothing removes the directory. The run stays `dispatched` with a dead lock owner. The next call marks the run `interrupted`, and `dispatch --resume-interrupted` starts a new turn in a new `al-*` directory. The old directory stays in the inherited temporary directory with no owner (issue #1207).

## Decision

1. **Record before the spawn.** `withTurnTmpdir` takes an `onCreated(record)` callback, awaited after the directory exists and before the child starts. The record holds the path, the real path of the parent, and the device and inode. A role dispatch stores it as `lastDispatch.turnTmpdir` in the state file. A failed callback warns and never fails the turn.
2. **Remove on recovery.** When a call finds the run `dispatched`, the lock owner is dead, so no child of that turn is writing into the directory. Before it marks the run `interrupted`, the call removes the recorded directory through the removal helper of ADR 0047, with the same device, inode, and parent checks. A directory that is gone, or that something replaced, is not followed.
3. **Only a turn directory.** The state file is editable, so the call refuses a record whose path is not absolute or whose name is not an `al-` name with a six-character `mkdtemp` suffix. A refused record deletes nothing.
4. **Never fails the call.** A refused or failed removal warns, as in a normal turn, and the call marks the run `interrupted` as before.

## Consequences

- A dispatch killed during a Codex turn leaves no `al-*` directory after the next call on that run.
- The state file of a Codex turn holds a path under the temporary directory of the host.
- A run that no later call touches keeps its directory.
- The limits of ADR 0047 decision 7 and the Windows identity check (issue #709) apply to this removal.

## Alternatives

1. **Remove every `al-*` directory that no live process owns.** Not taken. The prefix alone is not the runtime's own name, because a reviewer can create `al-probe` (ADR 0047).
2. **Remove the directory at process start.** Not taken. A start has no record of which directory belonged to which run.

## Authors

Andro Marces

## Links

- [Issue #1207](https://github.com/andromarces/agent-loops/issues/1207)
- [PR #1212](https://github.com/andromarces/agent-loops/pull/1212)
- [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md)
- Implementation:
  - Source: `withTurnTmpdir` and `removeAbandonedTurnTmpdir` in `src/lib/turn-tmpdir.mjs`, `runCodex` in `src/agents/codex.mjs`, `runChild` in `src/child-turn.mjs`, `recoverLifecycle` in `src/role-dispatch.mjs`
  - Tests: `tests/role.dead-turn-tmpdir.test.mjs`, `tests/lib/turn-tmpdir.test.mjs`
  - Docs: `docs/reference/architecture.md`, `docs/reference/role.md`
- [ADR Index](README.md)
