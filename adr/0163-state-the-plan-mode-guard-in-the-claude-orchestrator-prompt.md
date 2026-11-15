# 0163. State the plan-mode guard in the Claude orchestrator prompt

## Status

partially-superseded

The superseded part is decision 3, which declines the optional first-turn abort retry
([ADR 0164](0164-retry-a-first-turn-plan-mode-orchestrator-abort.md)). Every other decision,
consequence, and alternative stays in force.

## Superseded by

[adr/0164-retry-a-first-turn-plan-mode-orchestrator-abort.md](0164-retry-a-first-turn-plan-mode-orchestrator-abort.md) partially supersedes this ADR. The replaced part is decision 3, which states that the optional first-turn abort retry is not taken. The prompt rule of decision 1 and the Claude-only scope of decision 2 stay in force, and every other decision, consequence, and alternative stays in force.

## Date

2026-11-16

## Context

A headless Claude orchestrator turn runs with `--permission-mode plan` as a write guard, applied by
`runClaude` in `src/agents/claude.mjs`. The headless prompt in `src/prompts/orchestrator.mjs` did
not say that plan mode is only a guard, so a model could read the CLI reminder as a block.

One batch loop with `--orchestrator claude --orchestrator-model claude-opus-5-5
--orchestrator-effort high`, `--worker claude`, `--reviewer codex`, and `--loops 5` on Windows
returned `{"action": "abort"}` on its first orchestrator turn. The reason named plan mode and
proposed a rerun without it. That turn also wrote a plan file under the user's Claude plans
directory, and the loop ended failed with 0 steps used.

Four other loops of the same batch dispatched normally, and a rerun of the same issue in a new
batch succeeded. The failure is therefore nondeterministic and comes from the model's reading of the
reminder, not from the runtime.

## Decision

1. **The Claude orchestrator prompt states the plan-mode guard.** The initial prompt for
   `orchestratorKind` `claude` states that the turn runs in plan mode as a write guard only, that
   plan mode is never a reason to abort, that the turn acts by returning its JSON decision, that the
   runtime carries out that action, and that the turn writes no plan file.
2. **Only the Claude prompt states it.** `planModeBlock` adds the rule only for `claude`, because no
   other adapter runs a read-only turn in plan mode. Every other orchestrator prompt stays byte for
   byte as before.
3. **The prompt is the fix.** The optional first-turn abort retry is not taken in this change. A
   retry path would add a runtime transition and its own test surface, and the issue marks it
   optional.

## Consequences

- A Claude orchestrator reads that its JSON action is how the turn acts, so the plan-mode reminder
  is no longer evidence for an abort.
- The rule is advisory prompt text. A model that ignores it can still abort, and live behavior is
  unverified until a headless Claude orchestrator run is recorded in the live-runs checklist.
- The prompt of every other orchestrator kind is unchanged.

## Alternatives

1. **Retry a first-turn abort whose reason names plan mode.** Not taken in this change, as decision 3
   states. The issue marks it optional and the prompt rule is the proposed fix.
2. **Drop plan mode from the orchestrator.** Rejected. The runtime mutation check detects an edit and
   halts the run; it does not prevent one, so the CLI write guard stays.
3. **State the rule on every later prompt too.** Rejected. The first turn receives the full prompt in
   its Claude session, and a later-turn repetition adds text and tests without evidence that a later
   turn aborts.

## Authors

Andro Marces

## Links

- [Issue #1990: Headless Claude orchestrator aborts because it reads its plan-mode guard as a block](https://github.com/andromarces/agent-loops/issues/1990)
- [Pull request #1993](https://github.com/andromarces/agent-loops/pull/1993)
- Implementation: the headless prompt in [src/prompts/orchestrator.mjs](../src/prompts/orchestrator.mjs)
- Tests: [tests/prompts/orchestrator.test.mjs](../tests/prompts/orchestrator.test.mjs)
- [ADR Index](README.md)
