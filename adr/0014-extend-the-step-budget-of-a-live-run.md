# 0014. Extend the step budget of a live interactive run

## Status

accepted

## Date

2026-09-30

## Context

`maxSteps` is an init field, so no call changes it on an existing run. A run that
used its whole budget refuses every dispatch with `Step budget exhausted`. The only
way on was `abort` and a new init, which sets every role to `sessionId: null`. Each
role then starts a new session, sends the preamble again, and loses its conversation
history and provider prompt cache. `archiveState` keeps the old ids in
`state.<timestamp>.json`, but nothing reads that file again (issue #361).

## Decision

1. `agent-loop role extend --cwd <dir> --max-steps <count>` raises `maxSteps` of a
   non-terminal run in place. The state file stays, so the stored role session ids
   and the first-turn tracking keep working.
2. `--max-steps` uses the parse-time check that init uses (`readMaxSteps`, 1 to
   `Number.MAX_SAFE_INTEGER`). The value must also exceed `stepsUsed` and the
   current `maxSteps`. The operation raises the budget only, and a refusal leaves
   the state file unchanged.
3. `extend` re-checks the stored `maxSteps` like `dispatch` and `finish` (ADR 0008,
   point 7). `abort` stays the route out of a state file with an unsafe budget.
4. `extend` is accepted from `active`, `dispatched`, and `interrupted`, and refuses
   a terminal lifecycle. It leaves the lifecycle as it is, so it neither resumes nor
   recovers an interrupted run. It takes the state lock like every other write.
5. Each change appends `{ from, to, stepsUsed, at }` to a new `budgetChanges` array
   in the state file. `stepsUsed` places the change in the turn sequence: the change
   ran after that many charged turns. `turns` keeps its fixed shape and its
   one-entry-per-charged-step rule (ADR 0008), so a budget change is not a turn.
   A run never extended has no `budgetChanges`.
6. Raising the budget is the user's decision. The orchestrator instructions tell the
   parent to run `extend` only when the user authorized more steps, and to `abort`
   otherwise.
7. `extend` enforces that the caller is the parent. It requires `--parent-session`
   and refuses a value that differs from the stored `parentSession`, the identity
   the parent-edit guard matches (ADR 0006). A child role runs in its own harness
   session, so it cannot raise its own limit by calling `extend` after `dispatch`
   releases the lock. The refusal does not name the stored id. No child
   environment marker exists at spawn, and the other operations rely on the
   prompt rule alone, so this is the only operation with a session check.
   Limit: a child that reads the state file learns the id. The boundary holds
   against a child that follows the rules, as the guard does, not against one
   that reads the file.

## Consequences

- An exhausted run continues with its role sessions and prompt cache.
- The bound in ADR 0008 point 5 still holds: `maxSteps` only grows, so `turns` never
  exceeds it. `budgetChanges` grows by one small entry per `extend`. The strict
  raise and the safe-integer ceiling bound its length. No pruning rule exists.
- The headless loop is unchanged. Its `--max-steps` stays fixed for the invocation,
  and the runtime prompt states that number.
