# 0085. Let the inherited temporary directory re-check read a terminal run

## Status

accepted

Partially supersedes [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md). It replaces decision 3's requirement that the command reads a non-terminal run. The parent-only rule, the stored parent session id requirement, and the refusal of a child role remain in force.

It restates the part of [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md) that named that decision in force. Every decision of ADR 0082 remains in force.

## Date

2026-11-07

## Context

`role recheck-tmpdir` refused a run that was no longer active with `Run is already finished.` The orchestrator instructions run the re-check before the finish summary, but a parent that calls `finish` first, by mistake or after a compaction, has no later read (issue #1575). Its summary then keeps the raw `inheritedTmpdirEntries` lists under `open`, including GUID `.tmp` names that were gone minutes later (issues #1559 and #1569).

The command already changes nothing. It reads the run state and the inherited temporary directory, writes no run state, takes no state lock, and deletes no entry. A terminal state keeps the recorded names: `finish` does not archive the state file, and its state write keeps the recorded names. The lifecycle gate adds no safety: the read has no effect on the run, and the parent-only and child-role guards still apply.

## Decision

1. **Read any lifecycle.** `role recheck-tmpdir` reads the run state at `--cwd` without a lifecycle check. It reports the recorded names that remain on an `active`, `dispatched`, `interrupted`, `finished`, `aborted`, or `halted` run.
2. **Keep every other guard.** The command still requires the stored `--parent-session` id, still refuses a child role, and still refuses a changed init flag. It still takes no state lock, writes no run state or file, deletes or moves nothing, and reports names only.
3. **Keep the read and wait rules.** Every decision of ADR 0081 and ADR 0082 on the recorded names, the poll interval, the bound, the failed read, the unsafe name, the recreated name, the redaction, and the cap remains in force.

## Consequences

- A parent that finished the run first can still run the re-check and carry into `open` only the names that remain.
- A terminal lifecycle no longer refuses the read, so no later state change is needed for the parent to get the result.
- The command still makes no claim about a later state, and a name removed after the last read still reaches the summary.
- The state file does not grow, because the command still writes nothing.

## Alternatives

1. **Make `role finish` refuse or warn when no re-check ran.** Not taken. `finish` would inspect prose or track a separate mark, and a refused finish spends a corrective turn. The read itself has no side effect, so the lifecycle gate protects nothing.
2. **Add a new read-only subcommand.** Not taken. The existing command already performs the read, and a second name would duplicate its rules.

## Authors

Andro Marces

## Links

- [Issue #1575](https://github.com/andromarces/agent-loops/issues/1575)
- [PR #1580](https://github.com/andromarces/agent-loops/pull/1580)
- [ADR 0081: Re-check the inherited temporary directory names before the finish summary](0081-re-check-the-inherited-tmpdir-names-before-the-finish-summary.md)
- [ADR 0082: Wait for a reported inherited temporary directory name to vanish](0082-wait-for-a-reported-inherited-tmpdir-name-to-vanish.md)
- Implementation:
  - Parent command: `recheck-tmpdir` in `src/role/index.mjs`
  - Docs: `docs/reference/role.md`, `docs/orchestrator/runtime-advisory-fields.md`, and `src/help.mjs`
  - Tests: `tests/role.recheck-tmpdir.test.mjs`
- [ADR Index](README.md)
