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
3. The gate state is restored only on an unchanged tree (issue #393, which
   supersedes the first version of this item, a plain reset). A headless run
   returns its gate state (`workerRan`, `reviewerRan`, `reviewerTurnDispatched`,
   `acceptedSinceWorker`, `lastReviewed`) and the CLI writes it to the transcript
   as `gate`. `runLoop` takes `continued` and `earlierGate`. It restores the gate
   only when `lastReviewed` is an exact snapshot and the current snapshot is exact
   with the same head and digest. Otherwise it resets: `continued` starts
   `workerRan` true and the other gate inputs start empty, so a finish needs
   reviewer evidence from the continued run. `finishRefused` is never persisted,
   because it paces refusals and is not completion evidence. A run that ends on a
   thrown error writes no `gate`, so its continuation resets. The orchestrator
   prompt states the new budget and which of the two cases applies.
4. The interactive design of issue #361 shares nothing with this change. Its state
   file already holds the sessions and the gate state, so it only raises the
   budget. `src/lib/continuation.mjs` takes plain role objects, so a later change
   can reuse the compatibility check.

## Consequences

- A continuation on the tree that the earlier run last reviewed costs no extra
  reviewer turn. A continuation on a changed tree, or with no usable `gate`,
  costs at most one.
- A continuation never accepts a finish on a saved verdict for a tree that may
  have changed: the restore needs the same head and digest, so an edit between
  the runs resets the gate.
- The transcript gains a top-level `gate` field. A transcript with no `gate`
  continues with the reset. A `--transcript` file inside the work tree is an
  untracked file, so it changes the digest and keeps the reset.
- **Accepted gap:** a change of a CLI's own default model between the two runs is
  not detected. The transcript records the model the caller requested, not the
  model a CLI resolved, so an omitted model matches only an omitted model and no
  check can compare the defaults. Pass an explicit `--<role>-model` in both runs
  to pin it.
- A transcript from an earlier version, written before this change, continues
  without change, because it already holds `roles` and `cwd`.

## Alternatives considered

1. **Persist and restore the gate state with no tree check**: rejected. The saved
   accept cannot cover an edit made between the runs. Item 3 adds the check.
2. **A new session-state file next to the transcript**: rejected. The transcript
   already holds the ids, and a second file adds a second source of truth.
3. **Restore only when the tree digest matches**: first rejected for the cost of a
   second snapshot read and a new file format, then adopted by issue #393 as item 3,
   in the existing transcript.
4. **Compare an effective model per adapter**: rejected. It needs adapter
   knowledge in the check, cannot name a CLI default, and treated an omitted model
   differently across CLIs. The exact-value rule is the same for all.

## Authors

Andro Marces

## Links

- [Issue #362: Continue a headless run with a new step budget and its earlier role sessions](https://github.com/andromarces/agent-loops/issues/362)
- [Issue #393: Restore the headless gate state on --continue-from when the tree is unchanged](https://github.com/andromarces/agent-loops/issues/393)
- Implementation: `src/lib/continuation.mjs` (`matchingGate`), the `continued` and `earlierGate` inputs of `runLoop`
  and `initialPrompt`, and `--continue-from` in `src/cli.mjs`; tests in
  `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, and
  `tests/runtime.test.mjs`; documented in `README.md`
- [ADR Index](README.md)
