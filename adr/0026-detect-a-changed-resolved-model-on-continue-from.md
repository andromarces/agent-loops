# 0026. Detect a changed resolved model on --continue-from

## Status

accepted

Supersedes [ADR 0023: Restore the headless gate state on a continued run](0023-restore-the-headless-gate-state-on-a-continued-run.md). The decisions of ADR 0023 that still hold are restated below. One changes: the accepted gap about a changed CLI default model closes for the CLIs that report their resolved model.

## Date

2026-10-07

## Context

A headless run that reaches its step limit exits 2 and keeps its work tree, but a new invocation builds every role with `sessionId: null`. The `--transcript` file records each role's final session id (issue #362). ADR 0023 restores the completion gate state on an unchanged work tree (issue #393) and compares the recorded role model and effort exactly. The transcript records the model the caller requested. An omitted model, and an alias such as `opus`, resolve inside the CLI, so a change of that default or alias target between the two runs went undetected, and the continued run resumed a session under another model (issue #394). ADR 0023 recorded this as an accepted gap. This ADR closes the gap for the CLIs whose output names the resolved model, so it supersedes ADR 0023 and restates its decisions.

A probe of the five CLIs on macOS shows which outputs name the resolved model:

| CLI      | Output that names the model                                                | Used                                    |
| -------- | -------------------------------------------------------------------------- | --------------------------------------- |
| claude   | `modelUsage` keys of the `--output-format json` result                     | yes, when exactly one well-formed key   |
| copilot  | `data.model` of each `assistant.message` event of `--output-format json`   | yes, when all messages name one model   |
| codex    | none: the `--json` events carry the thread id and usage only               | no                                      |
| agy      | none: the `--output-format json` result carries the conversation and usage | no                                      |
| opencode | none in a normal stream: the model appears only inside a provider error    | no (already stated in the adapter note) |

## Decision

1. `--continue-from <transcript>` reads the session ids from the `roles` of an earlier transcript and gives the run a new `--max-steps` budget.
2. The run is refused before any turn when a role kind, a role's recorded model, a role's recorded effort, or `--cwd` differs from the earlier run. One rule covers every CLI: model and effort compare exactly, so an omitted value matches only an omitted value. The resolved-model check of decisions 8 to 11 adds a refusal for a changed CLI default. A refusal writes no transcript. The transcript write is atomic, so a failed write keeps the earlier file. When `--transcript` names the same file, the rewrite keeps the earlier events and adds a `continued` event with the earlier outcome.
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
8. An adapter that reads a resolved model from its output sets `state.resolvedModel` after a successful turn, only from well-formed, unambiguous evidence: at least one value, every value a model id (a non-empty string with no whitespace or control character), and all values equal. Any other output changes nothing: the last well-formed model stays, because it is the baseline of the next comparison. The Claude adapter reads the keys of `modelUsage`, which must be an object whose entries are objects; more than one key means a subagent or helper model ran too, so the role model is unknown and the turn records nothing. The Copilot adapter reads the `model` of every `assistant.message` event that has the field; different models, or a malformed value, record nothing. A failed turn changes nothing either. The role objects hold the field, so the transcript `roles` record it. Codex, agy, and opencode record none.
9. `restoreSessions` copies a recorded `resolvedModel` to the new role, so a role that does not run in the continued run keeps the record for the next continuation.
10. After `restoreSessions` and before any turn, `verifyResolvedModels` runs one read-only probe turn per role that has a recorded `resolvedModel`, through `runProbeTurn`. The probe uses the role kind, model, and effort of the new run, in a new session, never the continued one, in `--cwd`, with the `--timeout` bound. It runs under the guards of a child turn: the mutation check (a probe that changes the work tree throws `MutationError`, and a failed snapshot throws `SnapshotError`) and the run's SIGINT signal, which cancels the CLI call. Either halts the continuation with no transcript write, exit 1 for a mutation and 130 for a cancel. The run is refused with exit 1 when the probe resolves a model that differs from the recorded one. The message names the role and both models, and states that a new `--<role>-model` value is refused by the flag rule, so the recovery is to restore the earlier CLI default or to start a new run without `--continue-from`.
11. A probe that reports no model passes with a warning, because nothing can be compared. Any other probe failure refuses the continuation, because the model is then unverified. A role with no recorded `resolvedModel` is not probed, and the operator is told that the check did not run: a warning for a CLI that can report a model (an earlier version wrote the record, or the turn named no unambiguous model), and an info line for a CLI that never reports one.

## Consequences

- A continuation on the tree that the earlier run last reviewed costs no extra reviewer turn. A continuation on a changed tree, or with no derivable gate, costs at most one.
- A continuation never accepts a finish on a saved verdict for a changed tree: the restore needs the same head and digest.
- The transcript gains one event type, `gate`, that holds the final gate state. A transcript from an earlier version has none, so it continues with the reset, as it did before this change.
- **Accepted gap:** the transcript is a local file with no signature. The restore checks that the events are well formed and replay to the recorded state, and that the work tree matches. It does not check any event against another source, and it makes no promise about a deleted, added, or reordered event beyond that replay: an edit resets only when it makes an event invalid or makes the replay differ from the `gate` event. The gap is a forged sequence that is well formed and replays to the recorded state, for example a transcript whose events and `gate` event were all rewritten to end on an accept of the current head and digest. The same trust already covers the session ids in that file.
- A run that ends on a thrown error (for example SIGINT) writes no `gate` event, so its continuation resets, and so does a continuation of a same-file transcript whose later run ended on a thrown error.
- A continuation that restored a gate and ran no turn ends in a state that the replay, which restarts at the reset state, does not reproduce. The next continuation resets. That fails closed.
- A transcript file inside the work tree is an untracked file, so it changes the digest and keeps the reset. Keep it outside the work tree.
- A continuation whose `--transcript` path differs from `--continue-from` holds only its own events, so one that ran no turn has no result to restore from, and the next continuation resets.
- A continuation of a role on Claude or Copilot costs one extra model call per such role. Each call starts a session that the CLI keeps in its own session list.
- **Accepted gap:** a change of a CLI's own default model is not detected for Codex, agy, and opencode, which report no resolved model in their machine-readable output. Pass an explicit `--<role>-model` in both runs to pin it. An explicit model that is an alias is checked only on Claude and Copilot.
- **Accepted gap:** the `--output-format json` result of Claude Code names the models only as the keys of `modelUsage`, which lists an auxiliary or helper model beside the role model. A probe of the installed CLI (macOS) showed a single-valued `model` field only on the `system` `init` event of `--output-format stream-json --verbose`, and no model field in the `json` result. The adapter keeps `json` (see alternative 8), so the one-key rule applies and a multi-model Claude turn is not used as a baseline.
- **Accepted gap:** a Claude turn that reports several models in `modelUsage`, a Copilot turn whose messages name different models, and a turn whose evidence is malformed record nothing. A role whose every turn does has no baseline and is not checked, and the operator gets the warning of decision 11 on the next continuation. A role with an earlier well-formed model keeps it as the baseline.
- A transcript written before this change records no `resolvedModel`, so it continues unchecked, with the warning of decision 11.
- The probe runs before `assertGitWorkTree`. A `--cwd` that is not a Git work tree fails the probe's snapshot, so the run is refused.
- **Unverified:** the probe ran on macOS with the installed Claude Code and Copilot CLI only. A Windows run and other CLI versions are not verified.

## Alternatives

1. **Stored gate flags in the transcript**: rejected after review. An edited flag bypasses a gate. The `gate` event is a record that the replay of the events must reproduce.
2. **Restore with no tree check**: rejected. A saved accept cannot cover an edit made between the runs.
3. **A new session-state file next to the transcript**: rejected. The transcript already holds the ids and the results, and a second file adds a second source of truth.
4. **Compare an effective model per adapter from configuration**: rejected. It needs per-CLI knowledge of configuration layers and of the account default, and cannot resolve an alias.
5. **Compare after the first turn of each role**: rejected. The turn has already resumed the session under the changed model, so the check could only report it.
6. **Record every key of `modelUsage`**: rejected. A helper or subagent model that changes would refuse a continuation that the role model does not need to block.
7. **Record only, with no probe**: rejected. A record that nothing compares does not meet the issue.
8. **Read the Claude `init` event `model` from `--output-format stream-json --verbose`**: rejected for now. The field is single-valued and would cover multi-model turns. The switch changes the argv and the parsing of every Claude turn, the usage and failure paths, and the output size, which is out of scope for this change. Reserved for a change that moves the adapter to the streaming format.

## Authors

Andro Marces

## Links

- Supersedes [ADR 0023: Restore the headless gate state on a continued run](0023-restore-the-headless-gate-state-on-a-continued-run.md)
- [ADR 0015: Continue a headless run from its transcript](0015-continue-a-headless-run-from-its-transcript.md), superseded by ADR 0023
- [Issue #362: Continue a headless run with a new step budget and its earlier role sessions](https://github.com/andromarces/agent-loops/issues/362)
- [Issue #393: Restore the headless gate state on --continue-from when the tree is unchanged](https://github.com/andromarces/agent-loops/issues/393)
- [Issue #394: Detect a changed default model on --continue-from](https://github.com/andromarces/agent-loops/issues/394)
- [Pull Request #562](https://github.com/andromarces/agent-loops/pull/562)
- Implementation: `gateFromTranscript`, `matchingGate`, `verifyResolvedModels`, and `restoreSessions` in `src/lib/continuation.mjs`, `runProbeTurn` in `src/runtime.mjs`, `setResolvedModel` in `src/agents/shared.mjs`, the adapters `src/agents/claude.mjs` and `src/agents/copilot.mjs`, and `--continue-from` in `src/cli.mjs`; tests in `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, `tests/runtime.mutation.test.mjs`, `tests/agents/claude.test.mjs`, and `tests/agents/copilot.test.mjs`; documented in `README.md`
- [ADR Index](README.md)
