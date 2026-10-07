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

1. `agent-loop role extend --cwd <dir> --parent-session <id> --max-steps <count>` raises `maxSteps` of a
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
   otherwise. Point 7 states what the command enforces.
7. `extend` requires `--parent-session` and refuses a value that differs from the
   stored `parentSession`, the id the parent-edit guard matches (ADR 0006). The
   refusal does not name the stored id. A different `--parent-session` on `dispatch`,
   `finish`, or `abort` is refused by the init-flag check, and that refusal does name
   it. The id check does not identify the calling harness session, so a caller
   that read the id from the state file can pass it, a child role included. The
   check stops a call that omits the id or carries another one.
8. A child caller of the run is refused by a spawn-time marker bound to the run
   (issue #392). `exec` sets `AGENT_LOOP_SPAWNED_RUN=<run key>` in the environment
   of every worker and reviewer process. It sets nothing for the orchestrator or
   any other spawn. The run key is the name of the run's state directory, the hash
   that every subcommand uses to find the run state, so the marker and the lookup
   cannot disagree. The hash covers the lexical path with the Windows drive letter
   in lower case. Every descendant inherits the marker, a shell command of the turn
   included. `extend`, `finish`, and `abort` refuse a call whose value equals the key
   they use to find the run state, before any state read, so the run stays as it
   was. A path that spells the work tree another way, such as a symlink alias or a
   different case on a case-insensitive disk, computes another key and finds no
   state, so it cannot reach the run. A child that names the work tree as the run
   does is refused even when that work tree no longer exists, and a parent `abort`
   over a missing work tree still ends the run. A process that holds no marker, or a
   marker of another run, passes. The parent path therefore works on every
   supported harness, including a parent session that a child of another run
   started.
   The marker is a boundary against a child that follows its prompt, not against a
   hostile one. These limits remain:
   - A child that clears its environment, or a harness that filters it from shell
     commands, passes.
   - `exec` adds no marker to an orchestrator or a parent, but such a process keeps
     a marker it inherited. A headless orchestrator or an interactive parent that a
     child of the same run started holds that run's key and is refused for it,
     which happens only in the work tree of that run.
   - The variable holds one key. A worker or reviewer that a nested run starts
     through `exec` receives the key of the nested run and loses the outer key, so
     it can still end the outer run.
     In these cases the id check and the orchestrator instructions are the remaining
     guards.

## Consequences

- A child role cannot end or extend its own run through the CLI while the marker
  reaches its shell. A parent session that a child of another run started keeps
  every parent path for its own run. The limits of point 8 stay. `dispatch` and `wait-checks` stay open to every caller.

- An exhausted run continues with its role sessions and prompt cache.
- The bound in ADR 0008 point 5 still holds: `maxSteps` only grows, so `turns` never
  exceeds it. `budgetChanges` grows by one small entry per `extend`. The strict
  raise and the safe-integer ceiling bound its length. No pruning rule exists.
- The headless loop is unchanged. Its `--max-steps` stays fixed for the invocation,
  and the runtime prompt states that number.
