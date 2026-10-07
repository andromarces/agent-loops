# 0023. Restore the headless gate state on a continued run

## Status

superseded

Superseded by [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md). ADR 0026 restates the decisions of this ADR that still hold and closes the accepted gap about a changed default model for the CLIs that report it.

Supersedes [ADR 0015: Continue a headless run from its transcript](0015-continue-a-headless-run-from-its-transcript.md). The decisions of ADR 0015 that still hold are restated below. One changes: the completion gate state is restored on an unchanged work tree, where ADR 0015 reset it.

## Date

2026-10-07

## Context

A headless run that reaches its step limit exits 2 and keeps its work tree, but a new invocation builds every role with `sessionId: null`. The `--transcript` file records each role's final session id, because the loop mutates the same role objects (issue #362). ADR 0015 resets the completion gate state on `--continue-from` (`workerRan`, `reviewerRan`, `acceptedSinceWorker`, `lastReviewed`), because no file recorded it. A gated finish in the continued run then costs one reviewer turn, even when the earlier run ended on a reviewer accept of the same state (issue #393).

The transcript already records every child result, with the reviewed head and digest of each reviewer turn. A stored gate record would add a second source of truth that an edit can set to any value. A flag set to true in such a record bypasses `--require-accept`, and a `clean` value that is not a boolean can pass `--require-ci`.

## Decision

1. `--continue-from <transcript>` reads the session ids from the `roles` of an earlier transcript and gives the run a new `--max-steps` budget.
2. The run is refused before any turn when a role kind, a role's recorded model, a role's recorded effort, or `--cwd` differs from the earlier run. One rule covers every CLI: model and effort compare exactly, so an omitted value matches only an omitted value. A change of a CLI's own default model between the two runs is not detected, because the transcript records what the caller requested. A refusal writes no transcript. The transcript write is atomic, so a failed write keeps the earlier file. When `--transcript` names the same file, the rewrite keeps the earlier events and adds a `continued` event with the earlier outcome.
3. A headless run that returns an exit code appends a `gate` event as the last event of its transcript. The event holds the gate state of the run: `workerRan`, `reviewerRan`, `reviewerTurnDispatched`, `acceptedSinceWorker`, and `lastReviewed`. A run that ends on a thrown error (SIGINT, a fatal turn, a detected mutation) appends none.
4. `--continue-from` does not trust that record. It rebuilds the gate state by replaying the transcript events in file order through `applyResult`, the transition function that `runLoop` also applies after each child result: a worker result clears the accept, and a reviewer result sets `reviewerRan` when it ended `ok` and sets or clears the accept from its verdict and Checks line. Every result replaces the reviewed state with its own. A `continued` event restarts the replay at the reset state, and so does a transcript of a continued run that has none. The replay returns no state, which keeps the reset, unless all of these hold:
   - Every event is an object with a string `type`. Every `invocation` event has a role that is exactly `orchestrator`, `worker`, or `reviewer`. Every `result` event has a role that is exactly `worker` or `reviewer`, and the fields of its `ok` or `error` result with the right types (a string `response` or `error`, a reviewed state of strings and booleans when present).
   - No worker or reviewer invocation is left without a result.
   - The last event is the `gate` event.
   - The replayed state equals the `gate` event.
     Any unexpected value resets and never throws.
5. The replayed state restores only when it is well formed and the work tree is unchanged. Well formed means: the head is a Git object name or `unborn`, the digest is a SHA-256 hex string, `clean` is a boolean, and `exact` is true. Unchanged means the current snapshot is exact with the same head and digest. The restored `lastReviewed` is the current runtime state, so `clean` and `exact` never come from the file. Any other case keeps the reset: `runLoop` takes `continued`, which starts `workerRan` true, and every other gate input starts empty, so a finish needs reviewer evidence from the continued run. `finishRefused` is never restored, because it paces refusals and is not completion evidence.
6. The orchestrator prompt states the new budget, and states whether the gate was restored or reset.
7. The interactive design of issue #361 shares nothing with this change. `src/lib/continuation.mjs` takes plain role objects, so a later change can reuse the compatibility check.

## Consequences

- A continuation on the tree that the earlier run last reviewed costs no extra reviewer turn. A continuation on a changed tree, or with no derivable gate, costs at most one.
- A continuation never accepts a finish on a saved verdict for a changed tree: the restore needs the same head and digest.
- The transcript gains one event type, `gate`, that holds the final gate state. A transcript from an earlier version has none, so it continues with the reset, as it did before this change.
- **Accepted gap:** the transcript is a local file with no signature. The restore checks that the events are well formed and replay to the recorded state, and that the work tree matches. It does not check any event against another source, and it makes no promise about a deleted, added, or reordered event beyond that replay: an edit resets only when it makes an event invalid or makes the replay differ from the `gate` event. The gap is a forged sequence that is well formed and replays to the recorded state, for example a transcript whose events and `gate` event were all rewritten to end on an accept of the current head and digest. The same trust already covers the session ids in that file.
- **Accepted gap:** a change of a CLI's own default model between the two runs is not detected. Pass an explicit `--<role>-model` in both runs to pin it.
- A run that ends on a thrown error (for example SIGINT) writes no `gate` event, so its continuation resets, and so does a continuation of a same-file transcript whose later run ended on a thrown error.
- A continuation that restored a gate and ran no turn ends in a state that the replay, which restarts at the reset state, does not reproduce. The next continuation resets. That fails closed.
- A transcript file inside the work tree is an untracked file, so it changes the digest and keeps the reset. Keep it outside the work tree.
- A continuation whose `--transcript` path differs from `--continue-from` holds only its own events, so one that ran no turn has no result to restore from, and the next continuation resets.

## Alternatives considered

1. **Stored gate flags in the transcript**: rejected after review. An edited flag bypasses a gate. The `gate` event is a record that the replay of the events must reproduce.
2. **Restore with no tree check**: rejected. A saved accept cannot cover an edit made between the runs.
3. **A new session-state file next to the transcript**: rejected. The transcript already holds the ids and the results, and a second file adds a second source of truth.
4. **Compare an effective model per adapter**: rejected. It needs adapter knowledge in the check and cannot name a CLI default. The exact-value rule is the same for all.

## Authors

Andro Marces

## Links

- Supersedes [ADR 0015: Continue a headless run from its transcript](0015-continue-a-headless-run-from-its-transcript.md)
- [Issue #362: Continue a headless run with a new step budget and its earlier role sessions](https://github.com/andromarces/agent-loops/issues/362)
- [Issue #393: Restore the headless gate state on --continue-from when the tree is unchanged](https://github.com/andromarces/agent-loops/issues/393)
- [Pull Request #536](https://github.com/andromarces/agent-loops/pull/536)
- Implementation: `gateFromTranscript` and `matchingGate` in `src/lib/continuation.mjs`, the `continued` and `earlierGate` inputs of `runLoop`, and `--continue-from` in `src/cli.mjs`; tests in `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, and `tests/runtime.test.mjs`; documented in `README.md`
- Superseded by [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md)
- [ADR Index](README.md)
