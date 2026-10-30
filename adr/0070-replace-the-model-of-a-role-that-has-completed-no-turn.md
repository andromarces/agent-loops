# 0070. Replace the model of a role that has completed no turn

## Status

accepted

## Date

2026-10-30

## Context

`role dispatch` accepts any `--worker-model` or `--reviewer-model` at init, and the model is an init field that no later call changes. A CLI that refuses the model fails only on the first turn of that role. The only repair was `abort` and a new run, which starts every role on a new session, so the worker lost its conversation history (issue #1254). Codex 0.166.0-alpha.6 refused `gpt-6.1` on the first reviewer turn after the worker turn had completed.

The issue lists two approaches: check each model before the first child turn, or let a parent operation replace the model of a role that has no completed turn.

## Decision

1. **Replace, not probe.** A new operation, `role set-model`, replaces the model of one role. The init does not probe any model.
2. **Role and value.** The call carries exactly one of `--worker-model` and `--reviewer-model`. The flag names the role and holds the new model.
3. **Preconditions.** The run is `active`, so no turn is in flight or unresolved. The role is configured. The role has no `ok` entry in `turns`, and a run with no turn history is refused. For OpenCode, the new model must stay valid with the stored effort, with the init rule.
4. **Parent only.** The call needs the stored `--parent-session` id, as `extend` does, and a child role of the run is refused through the `AGENT_LOOP_SPAWNED_RUN` marker.
5. **Record.** The change is appended to `modelChanges` as `{role, from, to, at}`. The step count, the turn history, and the stored session id of the role stay.
6. **Other calls.** Every other call keeps rejecting a changed model flag.

## Consequences

- A refused model costs one failed turn and one parent call, and the worker keeps its session.
- The operation works the same for every adapter, because it reads no CLI output and calls no CLI.
- A model that a CLI accepts and later rejects after an `ok` turn is not covered: that role needs `abort` and a new run.
- The runtime does not tell a refused-model failure from another first-turn failure. The parent reads the error text and asks the user for the valid model.
- The state file gains the optional field `modelChanges`. A state file without it stays valid.

## Alternatives

1. **Probe each model at init.** Not taken. A probe is one child turn for each role, with its cost, and each CLI words its refusal in its own way, so the runtime needs a refusal reader for each of the five adapters. It also refuses an init for a model that a later turn would have accepted, for example after a quota or account change.
2. **Replace the model of a role that has an `ok` turn.** Not taken. The conversation already ran on the old model, and one session would then span two models.
3. **Let `dispatch` accept a changed model on a role with no `ok` turn.** Not taken. It leaves the parent-session check out of a change that `extend` and `declare-pr` guard, and it weakens the rule that a later call never changes an init field.

## Authors

Andro Marces

## Links

- [Issue #1254](https://github.com/andromarces/agent-loops/issues/1254)
- [PR #1256](https://github.com/andromarces/agent-loops/pull/1256)
- Related: [ADR 0014](0014-extend-the-step-budget-of-a-live-run.md), [ADR 0041](0041-declare-the-run-pr-after-init-with-declare-pr.md)
- Implementation:
  - Source: `setModel` in `src/role.mjs`, `rejectInitFlagChanges` in `src/role-args.mjs`
  - Tests: `tests/role.set-model.test.mjs`
  - Docs: `docs/reference/role.md`, `docs/orchestrator-instructions.md`, `docs/orchestrator/child-run-guard.md`
- [ADR Index](README.md)
