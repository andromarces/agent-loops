# 0019. Adopt a live run for a new parent session

## Status

accepted

## Date

2026-10-05

## Context

A run stores the `--parent-session` of the session that started it. The parent-edit
guard (ADR 0006, ADR 0007) matches that id, and `role extend` compares it (ADR 0014).
Every later call refuses a changed `--parent-session`, so a new session that
continues a non-terminal run another session started has no way to hold it. On
2026-10-04 a new session continued four such runs: its guard did not cover them, and
`extend` refused its id (issue #435). The only route was `abort` and a new init,
which loses every role session (ADR 0014 context).

## Decision

1. `agent-loop role adopt --cwd <dir> --from-session <stored id> --parent-session <new id>`
   rewrites `parentSession` in the same state file of a non-terminal run. Role
   sessions, budget, turns, and lifecycle stay as they are.
2. `--from-session` must equal the stored `parentSession`, the same check `extend`
   applies to `--parent-session` (ADR 0014 point 7). A missing or different value is
   refused without naming the stored id, and the state file stays unchanged. The
   command compares the id only and does not identify the caller, so the same limit
   holds: a caller that read the id from the state file passes, a child role
   included, and the rule that a child never runs `adopt` rests on the orchestrator
   instructions. The issue sketch carried only the new id. Without the stored id,
   any child with its own session id could take the guard from the parent, which
   would weaken the guard that `extend` does not weaken. `--from-session` is
   refused on every other operation.
3. The new id follows the init session id check. It must differ from the stored id.
4. The call writes the session entry for the new id, then the state file, then
   removes the entry for the old id. The old session's guard releases at the state
   write, because the guard matches the stored `parentSession`. A failed removal is
   logged and leaves an inert entry. The legacy index (`sessions/<id>`) is not
   touched: init no longer writes it, and the same stored-id match releases it.
5. `adopt` works from `active`, `dispatched`, and `interrupted`, and refuses a
   terminal run. It takes the state lock. It reads no budget, so an exhausted run
   can be adopted and then extended.
6. Each change appends `{ from, to, stepsUsed, at }` to `parentChanges`, as
   `extend` appends to `budgetChanges`. A run never adopted has no `parentChanges`.
7. The orchestrator instructions tell the parent to run `adopt` only when the user
   asked for the takeover.

## Consequences

- A resumed run from another session is guarded by the new session, and `extend`
  accepts the new id.
- The old session is released and cannot extend or dispatch the run.
- The parent-edit guard stays fail-open and prompt-backed, as in ADR 0006.
- `parentChanges` grows by one fixed-shape entry per adopt. Each call needs the
  stored id, so no pruning rule is needed.

## Alternatives

1. **Document the limit only**: rejected. The command fits the session-entry model
   with one entry move and one state field, and the guard needs no change.
2. **Accept a changed `--parent-session` on any dispatch**: rejected. It lets any
   caller change the parent silently and leaves no record.
3. **`adopt` with only the new id**: rejected. See point 2.
4. **Keep both sessions guarded**: rejected. Two parents break the single-owner rule
   of ADR 0006.

## Authors

Andro Marces

## Links

- [Issue #435](https://github.com/andromarces/agent-loops/issues/435)
- Implementation: `adopt` in `src/role.mjs`, help in `src/cli.mjs`; tests in
  `tests/role.adopt.test.mjs`; documented in `README.md`, `docs/parent-guard.md`,
  and `docs/orchestrator-instructions.md`
- [ADR Index](README.md)
