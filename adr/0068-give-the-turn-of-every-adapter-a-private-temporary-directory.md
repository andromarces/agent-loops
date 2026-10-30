# 0068. Give the turn of every adapter a private temporary directory

## Status

partially-superseded

Partially supersedes [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md). This ADR replaces the scope of decision 1, which covered a Codex turn only. Every other decision of ADR 0047 holds, and it now applies to the turn of every adapter.

Superseded in part by [ADR 0069: Mark the turn directories that any agent-loop process registered](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md):

- Decision 4, the `al-*` names stay reported: ADR 0069 keeps every entry listed and marks the turn directory that an agent-loop process registered with the prefix `registered/`. The exact-name leave-out of the turn directories of this process stays.

Decisions 1 to 3 remain in force: every adapter, one place, and recovery.

## Date

2026-10-30

## Context

A turn on an adapter other than Codex wrote its scratch files in the inherited temporary directory (issue #1178). With several `role` runs at once, a reviewer turn of one run listed the scratch files of a Claude Code worker of another run in `inheritedTmpdirEntries`, such as `edit_phases.py`, `fix2.py`, and `full.out`. The list cannot attribute an entry, so the parent carried unrelated names into `open`. Some scratch files stayed after both runs ended, and the worker report did not cover them.

ADR 0047 already gives a Codex turn a private directory that the runtime removes. ADR 0058 and ADR 0063 remove it after a dispatch that died.

## Decision

1. **Every adapter.** A worker or reviewer turn of the Claude Code, agy, Copilot, and opencode adapters runs with `TMPDIR`, `TEMP`, and `TMP` set to a private `al-XXXXXX` directory, created and removed as in ADR 0047, decisions 1 and 3 to 7. The environment carries the same pins as a Codex turn (ADR 0049).
2. **One place.** An adapter entry in `defaultAgents` with `privateTmpdir` set runs inside `runAgent` through `withTurnTmpdir`. The adapter reads the child environment from `options.env` and passes it to `exec`, and passes `options.onTurnChild` to `exec` as `onSpawn`. The Codex adapter keeps its own call, because its test and recovery paths are unchanged. An adapter that a caller injects with no flag runs as before.
3. **Recovery.** `runAgent` passes `options.onTurnTmpdir` to `withTurnTmpdir`, so a role dispatch records the directory and child of any adapter in `lastDispatch.turnTmpdir`. ADR 0058 and ADR 0063 then remove the directory of a dispatch that died.
4. **The `al-*` names stay reported.** `inheritedTmpdirEntries` still lists every `al-` name that this process did not create and is not removing, including the directory of a concurrent agent-loop process. A marker in the runs root would let the runtime tell the two apart, but a reviewer turn can write to the runs root too, so a forged marker would hide an entry that the reviewer created. The cost is a few names in an advisory list. ADR 0047 decided the same.

## Consequences

- A Claude Code worker leaves no scratch file in the inherited directory, and a concurrent reviewer report no longer lists it.
- A CLI that stores state in its temporary directory loses it after the turn. A resumed session reads the session store of the CLI, not the temporary directory.
- A user value of `CLAUDE_CODE_TMPDIR` stays, because the runtime sets only `TMPDIR`, `TEMP`, and `TMP`. Claude Code uses that variable for its internal temporary files, so with it set those files land outside the private directory and the runtime does not remove them. The scratch files of the worker commands still use the private directory. The runtime does not change the variable.
- A failed creation warns, and the turn uses the inherited directory, as for Codex.
- A reviewer report lists the `al-*` directory of a concurrent agent-loop process until that process removes it.
- The `opencode session export` call after a turn runs without the private directory. The runtime does not wrap that short read.

## Alternatives

1. **Wrap `exec` for every worker or reviewer spawn.** Not taken. `exec` and `withTurnTmpdir` import each other, and the Codex turn would need an opt-out.
2. **Wrap inside each adapter.** Not taken. Four call sites repeat one rule, and a new adapter can miss it.
3. **Tell the worker to clean up its scratch files.** Not taken. The worker report did not cover them in the observed case, and the runtime cannot check a prompt rule.
4. **Leave out the `al-*` directory of a concurrent process through a marker.** Not taken, see decision 4.

## Authors

Andro Marces

## Links

- [Issue #1178](https://github.com/andromarces/agent-loops/issues/1178)
- [PR #1237](https://github.com/andromarces/agent-loops/pull/1237)
- [ADR 0047: Give each Codex turn a private temporary directory](0047-give-each-codex-turn-a-private-temporary-directory.md)
- [ADR 0049: Pin the machine-wide roots for every child turn](0049-pin-the-machine-wide-roots-for-every-child-turn.md)
- [ADR 0058: Remove the turn directory of a dispatch that died mid-turn](0058-remove-the-turn-directory-of-a-dispatch-that-died-mid-turn.md)
- Superseded in part by: [ADR 0069](0069-mark-the-turn-directories-that-any-agent-loop-process-registered.md)
- [ADR 0063: Close the limits of the abandoned turn directory removal that the process group and the record origin cover](0063-close-the-limits-of-the-abandoned-turn-directory-removal-that-the-process-group-and-the-record-origin-cover.md)
- Implementation:
  - Source: `runAgent` and `defaultAgents` in `src/agents/index.mjs`, `src/agents/claude.mjs`, `src/agents/agy.mjs`, `src/agents/copilot.mjs`, `src/agents/opencode.mjs`
  - Tests: `tests/agents/index.test.mjs`
  - Docs: `docs/reference/architecture.md`, `docs/orchestrator/reviewer-sandbox.md`
- [ADR Index](README.md)
