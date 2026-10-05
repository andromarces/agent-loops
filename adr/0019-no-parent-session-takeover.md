# 0019. Do not let a new session take over a run

## Status

accepted

## Date

2026-10-05

## Context

A run stores the `--parent-session` of the session that started it. The parent-edit
guard (ADR 0006, ADR 0007) and `role extend` (ADR 0014) match that id, and every
later call refuses a changed `--parent-session`. A new session that continues a
non-terminal run another session started is therefore unguarded, and `extend`
refuses its id (issue #435).

The proposal was `role adopt`: move the session entry to the new session and record
the change in the state file. Two requirements decide it. The new session's guard
must cover the run and the old session's guard must release it, and a child role
must not be able to use the command.

## Decision

Do not add a takeover command. A run resumed from another session is unguarded for
the new session and cannot be extended by it. `docs/orchestrator-instructions.md`
states this under recovery. The route to a guarded, extendable run is `abort` and a
new run under the new session id, which starts every role on a new session.

A takeover command cannot meet the second requirement:

1. An id check does not stop a child. A child that reads `parentSession` from the
   state file passes `--from-session`, as it passes the `extend` check (ADR 0014
   point 7). On an idle run it can then move the guard to an unused id, which
   releases the real parent's guard while the run stays non-terminal. A reviewer
   probe confirmed this on the first version of the command.
2. Refusing the call while a run is `dispatched` does not close that route. It
   covers only a child during its own turn, and the state lock already blocks that
   case. An idle run stays open.
3. Evidence tied to the calling harness session does not exist for a Bash call. The
   guard hooks see a session id only on file-edit tools, and `Bash` stays allowed.
   Only some harnesses expose the session id to a child process, so a check built on
   it would fail open on the others.
4. A secret that only the old parent holds does not reach the new session, which is
   the case the command exists for.

## Consequences

- The limit stays: the new session has no guard, and `extend` refuses its id.
  Dispatch, finish, and abort carry no session check, so the new session can still
  drive and end the run.
- The prompt rule still keeps a child away from `extend`; no check backs it beyond
  the id compare of ADR 0014.
- No new state field, flag, or session-entry move exists, so ADR 0006 and ADR 0007
  stay unchanged.
- A later boundary that identifies the calling session can reopen this decision.

## Alternatives

1. **`role adopt --cwd <dir> --parent-session <id>`**: rejected. The issue's own
   shape has no stored-id check, so any caller takes the guard.
2. **`role adopt` with `--from-session <stored id>`**: rejected. See point 1.
3. **`role adopt` refused while `dispatched`**: rejected. See point 2.
4. **Accept a changed `--parent-session` on any call**: rejected. It lets any caller
   change the parent silently and leaves no record.

## Authors

Andro Marces

## Links

- [Issue #435](https://github.com/andromarces/agent-loops/issues/435)
- Documented in `docs/orchestrator-instructions.md` under recovery
- [ADR 0006](0006-require-parent-session-for-interactive-runs.md),
  [ADR 0014](0014-extend-the-step-budget-of-a-live-run.md)
- [ADR Index](README.md)
