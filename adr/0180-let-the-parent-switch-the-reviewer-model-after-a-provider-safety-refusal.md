# 0180. Let the parent switch the reviewer model after a provider-safety refusal

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0070: Replace the model of a role that has completed no turn](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md).
The replaced parts are decision 3's no-`ok`-entry precondition, decision 5's rule that the stored
session id stays, alternative 2's rejection of a change for a role with an `ok` turn, and the
consequence that a model a CLI accepts and later rejects after an `ok` turn is not covered. Each
replaced part applies only to the reviewer whose latest turn is a `provider-safety` refusal, as
this ADR states. Every other decision, consequence, and alternative of ADR 0070 stays in force.

This ADR also partially supersedes
[ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md).
The replaced part is decision 1's entry shape, which gains the provider `refusal` class on a
failed turn. Every other decision and consequence of ADR 0008 stays in force.

## Date

2026-11-28

## Context

[ADR 0070](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md) added `role set-model`,
so a model that a CLI refuses on the first turn of a role is repaired on the same run. It refuses
a role that has an `ok` turn, because one session would then span two models.

A Codex reviewer can end a later turn with a provider safety refusal, which
[issue #2056](https://github.com/andromarces/agent-loops/issues/2056) marks as
`refusal: "provider-safety"`. Rewording the prompt can clear one turn, but when the refusals
recur the parent has no way to move that reviewer to another model on the same run. The only other
path is `abort` and a new run, which loses the worker conversation too
([issue #2065](https://github.com/andromarces/agent-loops/issues/2065)).

## Decision

1. **One exception, for the reviewer only.** `role set-model --reviewer-model` accepts a reviewer
   that has an `ok` turn only when the latest entry for that role in `turns` is a failed turn
   whose `refusal` is `"provider-safety"`. Every other role and turn keeps ADR 0070's no-`ok`
   precondition.
2. **Persist the class in the turn entry.** A failed turn records its provider `refusal` class in
   its `turns` entry. The exception therefore reads stored state and never the error text. A state
   file written before the field exists refuses the exception, as it refuses a role with no turn
   history.
3. **Start a new reviewer session.** On that path the call clears the reviewer `sessionId`, its
   `sessionUnconfirmed` mark, and its `conversationReplaced` mark. The next reviewer dispatch then
   starts a new conversation and shows the init task again through the `taskSentTo` rule in
   [Init task delivery](../docs/orchestrator/task-delivery.md). The worker session, the step count,
   and the turn history stay. The no-`ok`-turn path keeps its session id unchanged.
4. **Record the change as before.** The replacement is appended to `modelChanges` as
   `{role, from, to, at}`. No field is added: the cleared session id and the next new-session turn
   show that the reviewer restarted.
5. **Keep every other guard.** Exactly one model flag is required; the run is `active`; the caller
   passes the stored `--parent-session` id; a child role is refused through the
   `AGENT_LOOP_SPAWNED_RUN` marker; the role is configured; a run with no turn history is refused;
   the OpenCode model and effort pair stays valid; and a request for the current model succeeds with
   no history entry and no state write, so it does not reset the session.
6. **The CLI stays an init field.** `--reviewer` cannot change after init. Only the model moves on
   this path. Every other call keeps rejecting a changed model flag.

## Consequences

- A reviewer that keeps a provider-safety refusal can move to another model on the same run, and
  the worker keeps its conversation.
- The old reviewer conversation is discarded. Its unreviewed history is lost by design, because a
  refusal that a model change answers cannot continue that conversation.
- A provider refusal that an adapter does not mark with `refusal: "provider-safety"` is not
  covered and keeps the ADR 0070 refusal.
- The turn history gains one optional field, so a state file without it stays valid and its failed
  turns carry no refusal class.
- The orchestrator instructions name the switch beside the provider-safety parent action, so a
  parent can act without inventing an operation.

## Alternatives

1. **Switch the reviewer CLI instead of its model.** Not taken. `--reviewer` is an init field, and a
   CLI switch changes more state than this repair needs.
2. **Keep the reviewer session and change its model.** Not taken. The conversation already ran on
   the refused model, and one session would span two models, against ADR 0070's reason for the
   `ok`-turn guard.
3. **Accept any later failed turn, not only a provider-safety refusal.** Not taken. Another failure
   can be transient or can leave a session worth resuming, and the narrower class has a stored
   marker.
4. **Add a session-reset field to `modelChanges`.** Not taken. The cleared session id and the next
   new-session turn already show the restart, so the entry keeps its shape.
5. **Reset the reviewer session on the no-`ok`-turn path too.** Not taken. That path keeps the
   current behavior, and a CLI that kept a usable id resumes it on the new model.

## Authors

Andro Marces

## Links

- [Issue #2065: Let the parent switch the reviewer model after a provider-safety refusal](https://github.com/andromarces/agent-loops/issues/2065)
- [ADR 0070: Replace the model of a role that has completed no turn](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR 0084: Charge no step for a first Codex turn that a model refusal ends](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md)
- Implementation: `setModel` in `src/role/index.mjs`, `recordTurn` in `src/role/dispatch.mjs`
- Tests: `tests/role/index.set-model.test.mjs`
- Docs: `docs/orchestrator-instructions.md`, `docs/reference/role.md`, `docs/orchestrator/run-history.md`
- [ADR Index](README.md)
