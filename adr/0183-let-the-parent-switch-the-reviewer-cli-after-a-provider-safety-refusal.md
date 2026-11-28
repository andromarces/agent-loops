# 0183. Let the parent switch the reviewer CLI after a provider-safety refusal

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0180: Let the parent switch the reviewer model after a provider-safety refusal](0180-let-the-parent-switch-the-reviewer-model-after-a-provider-safety-refusal.md).
The replaced parts are decision 6's rule that `--reviewer` cannot change after init and that only
the model moves on this path, the consequence that names only another model, the consequence that
names only the model switch in the orchestrator instructions, alternative 1's rejection of a CLI
switch because `--reviewer` is an init field, alternative 5's rule that only a model change
clears the session, and decision 5's no-write promise as it applies to a request that also changes
the CLI. Each replaced part applies only to the reviewer whose latest turn is a `provider-safety`
refusal. Every other decision, consequence, and
alternative of ADR 0180 stays in force.

## Date

2026-11-28

## Context

ADR 0180 gave `role set-model` one exception: a reviewer whose latest turn is a
`provider-safety` refusal may change its model on the same run and start a new session. The
reviewer CLI stayed an init field, so when every model of one provider refuses the same review the
only path is `abort` and a new run, which loses the worker conversation
([issue #2076](https://github.com/andromarces/agent-loops/issues/2076)).

A model name is meaningful only against a CLI. A model that one CLI accepts another CLI may refuse,
and the account, quota, or safety policy that refuses the model can belong to the CLI itself. The
same stored refusal class that proves no reviewer conversation is worth keeping also shows that a
CLI switch loses no review work.

## Decision

1. **One CLI option on the same path.** `role set-model` accepts `--reviewer <cli>` beside
   `--reviewer-model <model>` and an optional `--reviewer-effort <level>`. Exactly one model flag
   is still required, so a CLI switch always names the model that the new CLI runs, and an omitted
   effort clears the role's effort. The option is accepted only when the latest reviewer turn is a
   `provider-safety` refusal, with or without an earlier `ok` turn.
2. **Validate like init.** The new code path refuses an unknown or unsupported CLI and applies the
   same model and effort rule that init applies for the target CLI, the OpenCode pair rule. A model
   or effort that init passes through, including one that the batch parser only warns about, is
   accepted; ADR 0049 records working Copilot turns with `mai-code-1.1-flash`. It also reuses the
   init reviewer sandbox check: a stored `read-only` or
   `workspace-write` sandbox refuses a target other than Codex, and the refusal names
   `--reviewer-sandbox`, because the new CLI would drop that containment. A stored `none` sandbox
   holds no containment and is cleared on the switch, so no stored Codex option remains for the new
   CLI. A model-only call keeps the init check and the current role's CLI.
3. **Start a new reviewer session.** A successful CLI switch clears the reviewer `sessionId`, its
   `sessionUnconfirmed` mark, and its `conversationReplaced` mark, whether or not the model also
   changed. The next reviewer dispatch runs the new CLI in a new conversation and shows the init
   task again through the `taskSentTo` rule. The worker session, the step count, and the turn
   history stay.
4. **Record the CLI change.** A CLI change is appended to `cliChanges` as `{role, from, to, at}`,
   beside the existing `modelChanges` entry for a model change, even when the model string stays
   the same. The envelope adds `kind` and `previousKind` when the CLI changes. A model-only change
   keeps the ADR 0180 envelope and `modelChanges` shape.
5. **Keep every other guard.** Exactly one model flag is required; the run is `active`; the caller
   passes the stored `--parent-session` id; a child role is refused through the
   `AGENT_LOOP_SPAWNED_RUN` marker; the role is configured; a run with no turn history is refused;
   the latest reviewer turn must be the refusal; and a request that names the current CLI and model
   succeeds with no history entry and no state write. A `--reviewer` value that names the stored
   CLI follows the model-only path exactly: it writes no `cliChanges` entry, clears no session,
   and writes no state when nothing changes.
6. **The worker and the run stay.** Only the reviewer role changes. The worker session, the step
   count, and the turn history are unchanged.

## Consequences

- A reviewer that keeps a provider-safety refusal can move to another CLI, and with it another
  model and effort, on the same run, and the worker keeps its conversation.
- The old reviewer conversation is discarded. Its unreviewed history is lost by design, as ADR 0180
  states for the model switch.
- A switch to a CLI other than Codex is refused while the run holds a `read-only` or
  `workspace-write` Codex sandbox, so a containment mode is never dropped silently. A `none`
  mode is cleared, so no stored Codex sandbox option remains for the new CLI.
- A switch to Codex reads the stored reviewer sandbox mode. A run that started with another
  reviewer holds no `reviewerSandbox` field, so its Codex turn reads the legacy `read-only`
  mode (ADR 0038).
- The state file gains the optional `cliChanges` field. A state file without it stays valid.
- The envelope of a CLI change adds `kind` and `previousKind`. A model-only change keeps its
  shape.
- The interactive orchestrator instructions name the model and the CLI switch beside the
  provider-safety parent action. The headless prompt names the interactive option and still aborts,
  because a headless run holds no role state.

## Alternatives

1. **Abort and start a new run.** Not taken. It loses the worker conversation, which is the outcome
   issue #2076 exists to avoid.
2. **Add `fromCli` and `toCli` to the `modelChanges` entry.** Not taken. A sibling
   `cliChanges` field keeps the `modelChanges` shape that ADR 0180 decision 4 keeps.
3. **Allow a CLI switch after any failed turn.** Not taken, for the reason ADR 0180 alternative 3
   gives: only the stored provider-safety class proves the conversation is worthless.
4. **Rewrite the reviewer kind in the state file by hand.** Not taken. It bypasses the
   parent-session guard, the child-role guard, and the turn-history proof.

## Authors

Andro Marces

## Links

- [Issue #2076: Let the parent switch the reviewer CLI after a provider-safety refusal](https://github.com/andromarces/agent-loops/issues/2076)
- [PR #2077: Let the parent switch the reviewer CLI after a provider-safety refusal](https://github.com/andromarces/agent-loops/pull/2077)
- [ADR 0180: Let the parent switch the reviewer model after a provider-safety refusal](0180-let-the-parent-switch-the-reviewer-model-after-a-provider-safety-refusal.md)
- [ADR 0070: Replace the model of a role that has completed no turn](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR 0084: Charge no step for a first Codex turn that a model refusal ends](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md)
- [ADR 0038: Run the Codex reviewer with no sandbox by default](0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)
- [ADR 0049: Pin the machine-wide roots for every child turn](0049-pin-the-machine-wide-roots-for-every-child-turn.md)
- Implementation: `setModel` in `src/role/index.mjs`, `rejectInitFlagChanges` in `src/role/args.mjs`
- Tests: `tests/role/index.set-model.test.mjs`
- Docs: `docs/orchestrator-instructions.md`, `docs/reference/role.md`, `src/help.mjs`, `src/prompts/orchestrator.mjs`
- [ADR Index](README.md)
