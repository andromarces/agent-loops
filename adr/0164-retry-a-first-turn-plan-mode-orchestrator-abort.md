# 0164. Retry a first-turn Claude orchestrator abort that names plan mode

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0163: State the plan-mode guard in the Claude orchestrator prompt](0163-state-the-plan-mode-guard-in-the-claude-orchestrator-prompt.md). The replaced part is decision 3, which declines the optional first-turn abort retry. The prompt rule of decision 1, the Claude-only scope of decision 2, and every consequence and alternative stay in force.

## Date

2026-11-16

## Context

ADR 0163 decision 1 states the plan-mode guard in the Claude orchestrator prompt, and decision 3
leaves the optional runtime retry out. The rule is advisory prompt text. A model that ignores it
can still return `{"action": "abort"}` on the first orchestrator turn with a reason that names plan
mode, as issue #1990 recorded. `runLoop` in `src/runtime.mjs` read every `abort` action as a
terminal loop failure at exit 1. A batch loop with 0 steps used then ended `failed`, and only a new
batch run succeeded.

A retry at the runtime loop covers the case that the prompt rule misses. It is a classified fault,
not a general retry of every abort. The reason text names plan mode, and only a Claude orchestrator
runs a read-only turn in plan mode, so no other orchestrator kind can meet the condition.

## Decision

1. **A first-turn Claude abort that names plan mode is retryable.** `runLoop` takes one retry of
   the orchestrator turn when the loop is on its first orchestrator turn, the orchestrator kind is
   `claude`, the action is `abort`, and the reason matches `plan mode` or `plan-mode` in any case.
   The retry charges no step and does not end the loop. The guard counts orchestrator turns, not
   charged steps, because a refused finish starts a new turn without charging one.
2. **The fault is classified once.** A second plan-mode abort, an abort with any other reason, a
   non-Claude orchestrator, and a plan-mode abort on any orchestrator turn after the first end the
   loop at exit 1 as before.
3. **The retry restates the guard.** The retry prompt carries the previous reason as JSON text and
   repeats the plan-mode rule of ADR 0163 decision 1, so the turn learns that the guard is not a
   block and that the runtime carries out its returned action.

## Consequences

- A nondeterministic first-turn plan-mode abort no longer ends a batch loop with 0 steps used. The
  loop retries the same orchestrator session once with the guard restated.
- The prompt rule stays advisory. A model that aborts for plan mode twice still ends the loop at
  exit 1, and the reason stays in the transcript.
- An orchestrator kind other than Claude keeps every abort terminal, because no such adapter runs
  a read-only turn in plan mode.
- A plan-mode abort after a refused finish stays terminal, because that finish starts a new
  orchestrator turn, even though no step was charged.
- The retry adds no step, so the step budget and every finish gate read the same count as before.

## Alternatives

1. **Retry the whole batch loop.** Rejected. The fault is one orchestrator turn, and a new loop
   attempt spends another launch and transcript segment for a condition the runtime can classify.
2. **Retry every first-turn abort once.** Rejected. An abort with another reason states a real
   block, such as a spec contradiction, and a retry spends a turn without changing that state.
3. **Rely on the prompt rule alone.** Rejected. ADR 0163 recorded a live abort despite the rule,
   because the model reads the reminder, not the prompt contract, as the block.

## Authors

Andro Marces

## Links

- [Issue #1996: Retry a first-turn Claude orchestrator abort whose reason names plan mode](https://github.com/andromarces/agent-loops/issues/1996)
- [Pull request #1997](https://github.com/andromarces/agent-loops/pull/1997)
- [ADR 0163: State the plan-mode guard in the Claude orchestrator prompt](0163-state-the-plan-mode-guard-in-the-claude-orchestrator-prompt.md)
- Implementation: the orchestrator loop in [src/runtime.mjs](../src/runtime.mjs) and the retry prompt in [src/prompts/orchestrator.mjs](../src/prompts/orchestrator.mjs)
- Tests: [tests/runtime.test.mjs](../tests/runtime.test.mjs)
- [ADR Index](README.md)
