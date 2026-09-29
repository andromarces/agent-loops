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

1. The headless orchestrator runs each wait through `role wait-checks --pr <pr>
--timeout <seconds>`, the operation ADR 0010 defined. The prompt no longer
   names a `gh` watch.
2. The prompt renders the whole command, not a bare `agent-loop`.
   `waitChecksCommand` names `process.execPath` and the `src/cli.mjs` that this
   process runs, each in double quotes with forward slashes, so the command
   resolves for a global install, an `npm link`, and a clone run through `node
<repo>/src/cli.mjs` or `pnpm agent-loop`. A path holding `"`, `$`, a backtick,
   `%`, or a line break is not rendered, because the shells quote it differently,
   and the prompt then names no wait.
3. The prompt states `<seconds>` and derives it from the run's turn `--timeout`,
   which `runLoop` passes to `initialPrompt`: 300 seconds, or half the turn
   `--timeout` less the five-second child-exit ceiling when that is smaller. With
   `--timeout 0` (unbounded) the value is 300. The wait plus its child-exit
   window always ends before the turn does, and half the turn stays free for the
   orchestrator's own work.
4. A turn `--timeout` under 12 seconds fits no positive bound. The prompt then
   names no wait and tells the orchestrator not to run `gh pr checks` or
   `role wait-checks`. The `--require-ci` gate is the only check read, and a
   refused finish is corrected by a reviewer dispatch or an abort.
5. The status-read exception to the orchestrator role rule covers two commands:
   `gh pr checks` and `role wait-checks`. Both read status and change nothing.
6. A result of `"timedOut": true` is a completed read that left a required check
   pending. It is not a pass and not a finish condition. The orchestrator does not
   wait again in the same turn: it dispatches the reviewer, or aborts with the
   pending check named, and can wait again on a later turn.
7. The prompt keeps the ADR 0010 child-exit rule. `"childExitUnconfirmed": true`
   means the `gh` child was not observed to exit, so the orchestrator settles that
   process before another wait and does not wait again when it cannot.
8. `docs/orchestrator-instructions.md` ("Waiting in the headless loop") and the
   README state the same rule.

## Consequences

- A headless wait cannot end the run on the turn timeout for any turn
  `--timeout`, and the interactive and headless paths share one bounded wait and
  one timeout outcome.
- The prompt depends on the turn `--timeout`, so `initialPrompt` takes it as an
  input. A run that passes none gets the 300-second default.
- The command works wherever the run itself works, because it names the running
  Node binary and CLI script. It records the install location in the prompt, so a
  prompt is not portable to another machine.
- A run with a turn `--timeout` under 12 seconds, or an install path with a
  character that the shells quote differently, cannot wait, and only the
  `--require-ci` gate reads the checks.
- The orchestrator can run the command in a read-only turn on `claude`, `agy`,
  `opencode`, and `copilot`, the same CLIs that keep network for `gh`. `codex`
  stays unable to wait, as before.

## Alternatives

1. **Keep `gh pr checks --watch` and state a smaller "few minutes"**: rejected.
   `gh` has no timeout for a watch and a shell `timeout` is absent on Windows and
   on macOS without GNU coreutils, so the bound stays a request the orchestrator
   cannot enforce.
2. **A fixed 300-second bound in the prompt**: rejected. A run started with a
   turn `--timeout` under about 10 minutes could then wait past the turn.
3. **A one-second floor for a short turn**: rejected in review. A one-second turn
   would receive a wait of up to six seconds, so the guarantee failed at the edge.
   No wait is named instead.
4. **A bare `agent-loop` in the prompt**: rejected in review. A clone run has no
   `agent-loop` on `PATH`, so the command would fail there.
5. **A non-role equivalent command**: rejected. `wait-checks` writes no run state
   and needs no init, so it already serves the headless turn, and a second command
   would duplicate the outcome rules of ADR 0010.
6. **Let the orchestrator wait again in the same turn after a timeout**: rejected.
   The bound is half the turn, so a second wait can outlast the turn.

## Authors

Andro Marces

## Links

- [Issue #348: Bound the headless required-check wait with the runtime wait](https://github.com/andromarces/agent-loops/issues/348)
- Implementation: `headlessWaitSeconds`, `waitChecksCommand`, and the `wait` rule in
  `src/prompts/orchestrator.mjs`, the `timeout` input from `src/runtime.mjs`;
  tests in `tests/prompts/orchestrator.test.mjs` and `tests/runtime.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- [PR #382](https://github.com/andromarces/agent-loops/pull/382)
- [ADR 0010: A runtime-owned bound on the interactive required-check wait](0010-runtime-owned-required-check-wait-bound.md)
- [ADR Index](README.md)
