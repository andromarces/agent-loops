# 0013. Bound the headless required-check wait with the runtime wait

## Status

accepted

## Date

2026-09-29

## Context

ADR 0010 gave the interactive parent `agent-loop role wait-checks`, a wait with a
stated bound. The headless orchestrator prompt kept the older instruction: run
`gh pr checks <pr> --required --watch` and "bound the watch to a few minutes".
`gh` takes no timeout for a watch, so the prompt could not state a bound, and a
watch that outlasts the per-invocation `--timeout` (default 3600 seconds) ends the
run on exit 1 before the turn returns an action (issue #348, deferred from #329).

## Decision

1. The headless orchestrator runs each wait as `agent-loop role wait-checks --pr
<pr> --timeout <seconds>`, the command ADR 0010 defined. The prompt no longer
   names a `gh` watch.
2. The prompt states `<seconds>` and derives it from the run's turn `--timeout`,
   which `runLoop` passes to `initialPrompt`: 300 seconds, or half the turn
   `--timeout` less the five-second child-exit ceiling when that is smaller, and
   at least 1. With `--timeout 0` (unbounded) the value is 300. The command then
   returns within its bound plus the ceiling, inside the turn, and leaves the other
   half of the turn to the orchestrator's own work.
3. The status-read exception to the orchestrator role rule covers two commands:
   `gh pr checks` and `agent-loop role wait-checks`. Both read status and change
   nothing.
4. A result of `"timedOut": true` is a completed read that left a required check
   pending. It is not a pass and not a finish condition. The orchestrator does not
   wait again in the same turn: it dispatches the reviewer, or aborts with the
   pending check named, and can wait again on a later turn.
5. `docs/orchestrator-instructions.md` ("Waiting in the headless loop") and the
   README state the same rule.

## Consequences

- A headless wait cannot end the run on the turn timeout, and the interactive and
  headless paths share one bounded wait and one timeout outcome.
- The prompt depends on the turn `--timeout`, so `initialPrompt` takes it as an
  input. A run that passes none gets the 300-second default.
- The command must be reachable as `agent-loop` from the orchestrator turn. A
  checkout that runs the CLI through `node src/cli.mjs` only, with no `agent-loop`
  on `PATH`, cannot run it; the `--require-ci` gate still enforces the condition.
- A turn `--timeout` under about 12 seconds still gets a one-second bound, and
  the ceiling can push the command past half the turn.
- The orchestrator can run `agent-loop role wait-checks` in a read-only turn on
  `claude`, `agy`, `opencode`, and `copilot`, the same CLIs that keep network for
  `gh`. `codex` stays unable to wait, as before.

## Alternatives

1. **Keep `gh pr checks --watch` and state a smaller "few minutes"**: rejected.
   `gh` has no timeout for a watch and a shell `timeout` is absent on Windows and
   on macOS without GNU coreutils, so the bound stays a request the orchestrator
   cannot enforce.
2. **A fixed 300-second bound in the prompt**: rejected. A run started with a
   turn `--timeout` under about 10 minutes could then wait past the turn.
3. **A non-role equivalent command**: rejected. `wait-checks` writes no run state
   and needs no init, so it already serves the headless turn, and a second command
   would duplicate the outcome rules of ADR 0010.
4. **Let the orchestrator wait again in the same turn after a timeout**: rejected.
   The bound is half the turn, so a second wait can outlast the turn.

## Authors

Andro Marces

## Links

- [Issue #348: Bound the headless required-check wait with the runtime wait](https://github.com/andromarces/agent-loops/issues/348)
- Implementation: `headlessWaitSeconds` and the `wait` rule in
  `src/prompts/orchestrator.mjs`, the `timeout` input from `src/runtime.mjs`;
  tests in `tests/prompts/orchestrator.test.mjs` and `tests/runtime.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- [PR #382](https://github.com/andromarces/agent-loops/pull/382)
- [ADR 0010: A runtime-owned bound on the interactive required-check wait](0010-runtime-owned-required-check-wait-bound.md)
- [ADR Index](README.md)
