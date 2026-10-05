# 0021. Do not let a new session take over a run

## Status

accepted

## Date

2026-10-05

## Context

A run stores the `--parent-session` of the session that started it. The parent-edit
guard (ADR 0006, ADR 0007) and `role extend` (ADR 0014) match that id. After init,
`dispatch`, `finish`, and `abort` refuse a `--parent-session` that differs from it,
`extend` refuses every value but the stored id, and `wait-checks` ignores the flag.
A new session that continues a non-terminal run another session started is
therefore unguarded, because the guard matches the stored id, not the new session
(issue #435).

The proposal was `role adopt`: move the session entry to the new session and record
the change in the state file. Two requirements decide it. The new session's guard
must cover the run and the old session's guard must release it, and a child role
must not be able to use the command.

## Decision

Do not add a takeover command. A run resumed from another session is unguarded for
the new session. That session can run `extend` only by passing the stored id, which
`extend` compares as an id only, so the call succeeds for any caller that holds the
id and gives no guard coverage. `docs/orchestrator-instructions.md` states this
under recovery. The route to a guarded run is `abort` and a new run under the new
session id, which starts every role on a new session.

A takeover command cannot meet the second requirement:

1. An id check does not stop a child. A child that reads `parentSession` from the
   state file passes `--from-session`, as it passes the `extend` check (ADR 0014
   point 7). A wrong `--parent-session` on `dispatch`, `finish`, or `abort` also
   returns the stored id in its refusal. On an idle run a child can then move the
   guard to an unused id, which releases the real parent's guard while the run
   stays non-terminal. A reviewer probe confirmed this on the first version of the
   command.
2. Refusing the call while a run is `dispatched` does not close that route. It
   covers only a child during its own turn, and the state lock already blocks that
   case. An idle run stays open.
3. Session evidence exists in the guard hooks, but not on shell calls, and it would
   not identify a child. What each harness hands its guard (`docs/parent-guard.md`):
   - Claude Code, Codex CLI, and Copilot CLI: `session_id` in the `PreToolUse`
     input, on the tools the installed matcher selects. Those are the file-edit
     tools (`Edit|Write|MultiEdit|NotebookEdit`, `^apply_patch$`, `Edit|Write`).
   - Antigravity CLI: `conversationId` and `toolCall.name`, on the matched tools:
     the file-edit tools plus `invoke_subagent` and `send_message`.
   - OpenCode: the plugin registers its guard in `setup(ctx)` with
     `ctx.permission.hook("evaluate", ...)`. The callback reads `event.action` and
     `event.sessionID`. It returns without setting an effect when the action is not
     in `EDIT_ACTIONS` (`edit`) or `sessionID` is not a string. Otherwise it passes
     `sessionID` to `decideParentGuard` and, on a deny, sets `event.effect` and
     `event.message`. A lookup error is swallowed. The plugin also adds an
     `agent-loop` command through `ctx.command.transform` whose handler receives
     `sessionID`. A source comment states that the `shell` tool raises another
     action; the repository shows no `shell` event from OpenCode itself, so what such
     an event carries is not established.
     No installed guard acts on a shell call: the matchers above select only the
     listed tools, and the OpenCode callback returns for every action but `edit`. The
     `agent-loop` command runs through a shell. This ADR did not read or probe the
     payload of a shell tool call, so it does not claim that any harness puts the
     session id there. Assume it did: a hook that compares the session id with the new
     `--parent-session` compares a caller with itself. A child runs in its own harness
     session and would pass its own id, so the hook allows the call and the child takes
     the guard. A sound check must tell a runtime-spawned child from the user's new
     session, and a session id does not.
4. The environment does not tell them apart either, per the repository docs. The
   README states that a nested harness inherits `CODEX_THREAD_ID`, and
   `docs/parent-guard.md` states that child processes inherit
   `ANTIGRAVITY_CONVERSATION_ID`. ADR 0014 point 7 states that no child marker
   exists at spawn.
5. A secret that only the old parent holds does not reach the new session, which is
   the case the command exists for.

## Consequences

- The limit stays: the new session has no guard. `extend` refuses the new
  session's own id and accepts the stored id from any caller, so the new session can
  extend only by passing the stored id, and that gives no guard coverage.
  `dispatch`, `finish`, and `abort` check `--parent-session` only when it is given,
  so the new session can still drive and end the run by omitting it.
- The prompt rule still keeps a child away from `extend`; no check backs it beyond
  the id compare of ADR 0014.
- No new state field, flag, or session-entry move exists, so ADR 0006 and ADR 0007
  stay unchanged.
- A runtime-owned marker that a harness hook or the CLI can verify to separate a
  spawned child from a user session can reopen this decision. A session id alone
  cannot.

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
- [PR #486](https://github.com/andromarces/agent-loops/pull/486)
- Documented in `docs/orchestrator-instructions.md` under recovery
- [ADR 0006](0006-require-parent-session-for-interactive-runs.md),
  [ADR 0014](0014-extend-the-step-budget-of-a-live-run.md)
- [ADR Index](README.md)
