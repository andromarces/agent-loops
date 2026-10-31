# Parent session id after init

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a new session resumes a run, and before a call that passes `--parent-session` after init, such as `extend`, `declare-pr`, or `set-model`.

A run stores the `--parent-session` of the session that started it. The
parent-edit guard and `extend` match that id, and no later call changes it. After init,
each subcommand treats `--parent-session` as follows:

- `extend`, `declare-pr`, and `set-model`: required. A missing value or any value other than the stored id is
  refused, and the refusal does not name the stored id. The stored id is
  accepted.
- `dispatch`, `finish`, and `abort`: optional. When omitted, they check nothing
  and run. When given, a different value is refused with the error
  `--parent-session cannot be changed after init`, which names the stored id.
  A value equal to the stored id is accepted. `dispatch` also refuses a malformed
  id.
- `wait-checks`: reads no run state and ignores the flag.

A run that a new session resumes is therefore unguarded for that session (issue #435). No
call moves the stored id to the new session. The new session can run `dispatch`,
`finish`, and `abort` by omitting `--parent-session`. It can run `extend` and
`declare-pr` only by passing the stored id. Both compare the id only, so that call succeeds for
any parent-side caller that holds the id, and it gives no guard coverage. A child
role never runs `extend`, `declare-pr`, or `set-model`: the spawn-time marker refuses it, and the prompt rule
backs the marker. To get a guard, call `abort` and start a new run with
the new session id. A new run starts every role on a new session (ADR 0021).
