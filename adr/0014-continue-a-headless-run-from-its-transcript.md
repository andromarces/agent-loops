# 0014. Continue a headless run from its transcript

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
2. The run is refused before any turn when a role kind, a role model, or `--cwd`
   differs from the earlier run. Effort is not compared, because it changes no
   session. A refusal writes no transcript, so `--transcript` can name the same
   file.
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

## Authors

Andro Marces

## Links

- [Issue #362: Continue a headless run with a new step budget and its earlier role sessions](https://github.com/andromarces/agent-loops/issues/362)
- Implementation: `src/lib/continuation.mjs`, the `continued` input of `runLoop`
  and `initialPrompt`, and `--continue-from` in `src/cli.mjs`; tests in
  `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, and
  `tests/runtime.test.mjs`; documented in `README.md`
- [ADR Index](README.md)
