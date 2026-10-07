# 0023. Restore the headless gate state on a continued run

## Status

accepted

Supersedes [ADR 0015: Continue a headless run from its transcript](0015-continue-a-headless-run-from-its-transcript.md). The decisions of ADR 0015 that still hold are restated below. One changes: the completion gate state is restored on an unchanged work tree, where ADR 0015 reset it.

## Date

2026-10-07

## Context

A headless run that reaches its step limit exits 2 and keeps its work tree, but a new invocation builds every role with `sessionId: null`. The `--transcript` file records each role's final session id, because the loop mutates the same role objects (issue #362). ADR 0015 resets the completion gate state on `--continue-from` (`workerRan`, `reviewerRan`, `acceptedSinceWorker`, `lastReviewed`), because no file recorded it. A gated finish in the continued run then costs one reviewer turn, even when the earlier run ended on a reviewer accept of the same state (issue #393).

The transcript already records every child result, with the reviewed head and digest of each reviewer turn. A stored gate record would add a second source of truth that an edit can set to any value. A flag set to true in such a record bypasses `--require-accept`, and a `clean` value that is not a boolean can pass `--require-ci`.

## Decision

1. `--continue-from <transcript>` reads the session ids from the `roles` of an earlier transcript and gives the run a new `--max-steps` budget.
2. The run is refused before any turn when a role kind, a role's recorded model, a role's recorded effort, or `--cwd` differs from the earlier run. One rule covers every CLI: model and effort compare exactly, so an omitted value matches only an omitted value. A change of a CLI's own default model between the two runs is not detected, because the transcript records what the caller requested. A refusal writes no transcript. The transcript write is atomic, so a failed write keeps the earlier file. When `--transcript` names the same file, the rewrite keeps the earlier events and adds a `continued` event with the earlier outcome.
3. The gate state is derived from the `result` events of the earlier transcript. No stored flag is read. The state is derivable only when the last child turn is a reviewer turn that ended `ok` with a reviewed state:
   - `reviewerRan` and `reviewerTurnDispatched` are true.
   - `acceptedSinceWorker` is the `--require-accept` rule (`Verdict: accept` with a Checks line) applied to that turn.
   - `workerRan` is true when a worker result event exists or the earlier run was itself continued. That can only tighten a gate.
   - `lastReviewed` is the reviewed state of that turn.
4. The derived state restores only when it is well formed and the work tree is unchanged. Well formed means: the head is a Git object name or `unborn`, the digest is a SHA-256 hex string, `clean` is a boolean, and `exact` is true. Unchanged means the current snapshot is exact with the same head and digest. The restored `lastReviewed` is the current runtime state, so `clean` and `exact` never come from the file. Any other case keeps the reset: `runLoop` takes `continued`, which starts `workerRan` true, and every other gate input starts empty, so a finish needs reviewer evidence from the continued run. `finishRefused` is never restored, because it paces refusals and is not completion evidence.
5. The orchestrator prompt states the new budget, and states whether the gate was restored or reset.
6. The interactive design of issue #361 shares nothing with this change. `src/lib/continuation.mjs` takes plain role objects, so a later change can reuse the compatibility check.

## Consequences

- A continuation on the tree that the earlier run last reviewed costs no extra reviewer turn. A continuation on a changed tree, or with no derivable gate, costs at most one.
- A continuation never accepts a finish on a saved verdict for a changed tree: the restore needs the same head and digest.
- The transcript gains no field. A transcript from an earlier version continues without change.
- **Accepted gap:** the transcript is a local file with no signature. An edit that rewrites a result event and sets a matching head and digest can forge an accept for the current tree. The restore rejects an inconsistent or malformed file. It does not authenticate one. The same trust already covers the session ids in that file.
- **Accepted gap:** a change of a CLI's own default model between the two runs is not detected. Pass an explicit `--<role>-model` in both runs to pin it.
- A run that ends on a thrown error (for example SIGINT) leaves its last result event as the evidence. An edit made by the interrupted turn changes the digest, so the continuation resets.
- A transcript file inside the work tree is an untracked file, so it changes the digest and keeps the reset. Keep it outside the work tree.
- A continuation whose transcript holds only the events of an earlier continuation (a different `--transcript` path) still restores from its own last reviewer turn.

## Alternatives considered

1. **A stored `gate` record in the transcript**: rejected after review. An edited flag bypasses a gate, and a cross-check against the events makes the record redundant.
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
- [ADR Index](README.md)
