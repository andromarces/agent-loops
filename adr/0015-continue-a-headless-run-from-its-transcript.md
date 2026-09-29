# 0015. Continue a headless run from its transcript

## Status

accepted

## Date

2026-09-30

## Context

A headless run that reaches its step limit exits 2 and keeps its work tree, but a
new invocation builds every role with `sessionId: null`. The orchestrator, worker,
and reviewer lose their conversation history and provider prompt cache (issue
#362). The `--transcript` file already records each role's final session id,
because the loop mutates the same role objects. The completion gate state
(`workerRan`, `reviewerRan`, `acceptedSinceWorker`, `lastReviewed`) lives only in
memory in `runLoop`.

## Decision

1. `--continue-from <transcript>` reads the session ids from the `roles` of an
   earlier transcript and gives the run a new `--max-steps` budget.
2. The run is refused before any turn when a role kind, a role's recorded model,
   a role's recorded effort, or `--cwd` differs from the earlier run. One rule
   covers every CLI: model and effort compare exactly, so an omitted value
   matches only an omitted value. A change of a CLI's own default model between
   the two runs is not detected, because the transcript records what the caller
   requested. A refusal writes no transcript.
   The transcript write is atomic (a temporary file in the same directory, then a
   rename), so a failed write keeps the earlier file. When `--transcript` names
   the same file, the rewrite keeps the earlier events, read whole with no size
   limit, and adds a `continued` event with the earlier outcome.
3. The gate state is reset, not restored. `runLoop` takes `continued`, which
   starts `workerRan` true. The other gate inputs already start empty, so a
   finish needs reviewer evidence from the continued run. The orchestrator
   prompt states the new budget and the reset.
4. The interactive design of issue #361 shares nothing with this change. Its state
   file already holds the sessions and the gate state, so it only raises the
   budget. `src/lib/continuation.mjs` takes plain role objects, so a later change
   can reuse the compatibility check.

## Consequences

- A continuation costs at most one extra reviewer turn when the earlier run had
  already reviewed the current state.
- A continuation never accepts a finish on a saved verdict for a tree that may
  have changed.
- **Accepted gap:** a change of a CLI's own default model between the two runs is
  not detected. The transcript records the model the caller requested, not the
  model a CLI resolved, so an omitted model matches only an omitted model and no
  check can compare the defaults. Pass an explicit `--<role>-model` in both runs
  to pin it.
- A transcript from an earlier version, written before this change, continues
  without change, because it already holds `roles` and `cwd`.

## Alternatives considered

1. **Persist and restore the gate state**: rejected. It needs a new file format
   and a tree identity check, and the saved accept still cannot cover an edit made
   between the runs. Reserved for a change that persists headless state.
2. **A new session-state file next to the transcript**: rejected. The transcript
   already holds the ids, and a second file adds a second source of truth.
3. **Restore only when the tree digest matches**: rejected for the same reason as
   1, at the cost of a second snapshot read.
4. **Compare an effective model per adapter**: rejected. It needs adapter
   knowledge in the check, cannot name a CLI default, and treated an omitted model
   differently across CLIs. The exact-value rule is the same for all.

## Authors

Andro Marces

## Links

- [Issue #362: Continue a headless run with a new step budget and its earlier role sessions](https://github.com/andromarces/agent-loops/issues/362)
- Implementation: `src/lib/continuation.mjs`, the `continued` input of `runLoop`
  and `initialPrompt`, and `--continue-from` in `src/cli.mjs`; tests in
  `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, and
  `tests/runtime.test.mjs`; documented in `README.md`
- [ADR Index](README.md)
