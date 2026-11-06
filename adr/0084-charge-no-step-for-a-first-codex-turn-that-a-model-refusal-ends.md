# 0084. Charge no step for a first Codex turn that a model refusal ends

## Status

accepted

Partially supersedes [ADR 0070: Replace the model of a role that has completed no turn](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md). It replaces the consequence that the runtime does not tell a refused-model failure from another first-turn failure.

Partially supersedes [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md). It replaces decision 2's rule that exactly one entry exists per charged step, decision 5's `maxSteps` bound, and the consequence that the history is bounded by `maxSteps`.

Partially supersedes [ADR 0014: Extend the step budget of a live interactive run](0014-extend-the-step-budget-of-a-live-run.md). It replaces decision 5's one-entry-per-charged-step rule and the consequence that the ADR 0008 point 5 bound still holds.

Every other decision and consequence of ADR 0070, ADR 0008, and ADR 0014 remains in force.

## Date

2026-11-06

## Context

ADR 0070 added `role set-model`, so a refused role model no longer forces a new run. The refused first turn still charged a step. The parent learned the model was wrong only after one child spawn, and the repair then spent a step that ran no model turn (issue #1565).

A `review-first` init passed `--reviewer codex --reviewer-model gpt-6.1`. The first reviewer turn failed with `The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.` The parent ran `role set-model --reviewer-model gpt-6.1-sol` and dispatched again. The run continued, one step lighter.

A check against `~/.codex/models_cache.json` was dropped (PR #1568, closed unmerged). Codex can select a provider through config layers that init cannot read in full, so a prediction from config files can refuse a valid model.

## Decision

1. **Recognize the refusal in the Codex adapter.** When the last `error` or `turn.failed` event of a failed turn carries `The '<model>' model is not supported`, and the turn did not time out, get canceled, or end on a signal, the adapter sets `refusedModel` to that model id on the error. The match is narrow: a message that only quotes the text in another event, or another cause, marks nothing.
2. **Name the refusal and the model in the envelope.** The `role dispatch` error envelope carries `"refusedModel": "<model>"` beside `error`, which still carries the provider text. The parent can run `role set-model` without reading the error text.
3. **Refund the first turn of the role.** A dispatch that ends the first turn of a role on a recognized model refusal decrements `stepsUsed`. The turn still appends its `turns` entry, so the later refusal of a replaced model charges a step as before. The refund needs the `turnsComplete` mark that init writes, and a `turns` history with no earlier turn of the role. A state written before the mark existed never refunds, now or after a later write recreates part of the history.
4. **Charge every other failure.** A first turn that fails for another cause, and a refusal on a later turn, charge a step as before.
5. **Read no Codex config or model cache at init.** The adapter recognizes the refusal from the turn output. Init reads no provider config, requirements file, managed preference, or model cache.

The headless runtime keeps its step charge: it has no `role set-model` call on its in-memory run, so a refund would leave no repair path. The `turns` array can hold one entry more than `maxSteps` for each role whose first turn was refunded.

## Consequences

- A refused first turn costs no step, so the parent can repair the model and dispatch again inside the same budget.
- A model refusal on a later turn, and every other first-turn failure, still costs one step.
- Only Codex is covered, because only its adapter marks `refusedModel`. The other adapters keep their current first-turn charge.
- The state file keeps one `turns` entry per dispatched turn, so a refunded first turn is still visible to `set-model` and to a later dispatch. A state written before `turnsComplete` existed never refunds a refusal.
- A provider message that words its refusal another way is not recognized and charges a step, as before.

## Alternatives

1. **Read `models_cache.json` at init.** Not taken. The provider can be selected through config layers that init cannot read in full, so a config prediction can refuse a valid model.
2. **Refund the first turn of every adapter.** Not taken. No other adapter has a sourced refusal message, and a wrong mark would refund a real failure.
3. **Retry the turn automatically with another model.** Not taken. The runtime has no valid model to choose, and the parent must ask the user.
4. **Refund in the headless runtime too.** Not taken. The headless run has no `set-model` operation, so the refund would buy no repair.

## Authors

Andro Marces

## Links

- [Issue #1565](https://github.com/andromarces/agent-loops/issues/1565)
- [PR #1574](https://github.com/andromarces/agent-loops/pull/1574)
- [ADR 0070: Replace the model of a role that has completed no turn](0070-replace-the-model-of-a-role-that-has-completed-no-turn.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR 0014: Extend the step budget of a live interactive run](0014-extend-the-step-budget-of-a-live-run.md)
- Implementation:
  - Recognition: `runCodex` in `src/agents/codex.mjs`
  - Result field: `runChild` in `src/child-turn.mjs`
  - Refund and envelope: `dispatch` in `src/role/dispatch.mjs`
  - Docs: `docs/reference/role.md`, `docs/reference/architecture.md`, and `docs/orchestrator/run-history.md`
  - Tests: `tests/agents/codex.test.mjs` and `tests/role.dispatch.test.mjs`
- [ADR Index](README.md)
