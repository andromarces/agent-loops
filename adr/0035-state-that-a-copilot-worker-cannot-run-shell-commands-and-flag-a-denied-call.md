# 0035. State that a Copilot worker cannot run shell commands and flag a denied call

## Status

accepted

## Date

2026-10-10

## Context

The worker contract tells a worker to run tests, checks, and verifications (`src/prompts/worker.mjs`). A Copilot worker turn passes `--session-id <id> -s --no-ask-user --output-format json` and no allow flag (`src/agents/copilot.mjs`). Under these flags Copilot can refuse a shell call with `Permission denied because no interactive user response was available.` Issue #713 recorded two live worker turns on GitHub Copilot CLI 1.0.96-2 (macOS 27.2) where `bash <script path> <args>` was refused and did not run. The first turn returned `status: ok` with `report: null` and the denial text in `raw`. The README records the same refusal for the async shell under `--no-ask-user` alone, and a mixed result (some commands ran, some refused) for the exact runtime arguments, which it calls a Copilot default.

The issue left three options open: pass a scoped allow flag, document that a Copilot worker cannot run arbitrary shell commands, or fail the turn when a shell call is denied.

## Decision

1. The adapter passes no allow flag. `--allow-all-tools` is rejected as broader than the issue needs, and no recorded evidence shows that a scoped `--allow-tool 'shell(<command>)'` form runs a validation command under the runtime arguments. The worker would also need one pattern per validation command of each project.
2. The worker contract and the README state that a Copilot worker turn cannot rely on a shell command: Copilot can refuse it, and the refusal is a Copilot default that the adapter does not change. The parent must run the validation itself, or choose another worker CLI, when the task needs a command run.
3. A denied shell call does not fail the turn. A turn can finish useful edits and report the refusal, and a failed turn would charge a retry. Instead, the Copilot adapter sets `state.shellDenied` when the text of any assistant message of the turn holds `Permission denied because no interactive user response was available`. `runChild` moves the flag to the result and clears it from the role state. The `role dispatch` envelope of the turn carries `"shellDenied": true`, and so does the headless result prompt (`resultPrompt` in `src/prompts/orchestrator.mjs`), so a headless parent holds what an interactive parent reads. A turn with no match carries no field. Each turn clears the flag before its CLI call, so a later turn with no denial carries none.
4. The flag covers the worker and the reviewer, the two child turns that return a result. A reviewer is read-only, but a refused shell call hides a check it claims to have read, such as `gh pr checks`, so the parent needs the same signal. An orchestrator turn returns no result to carry the flag, so the runtime clears the flag from the orchestrator state after the turn and reports nothing for it.
5. The match is on the denial text, not on an event type, because no recorded Copilot event stream shows how a denial is reported. A stream that records the denial in a tool event with no matching assistant text is not flagged, and a model that quotes the text with no real denial is flagged. The flag is advisory, as `prChecks` is.

## Consequences

- A parent can see a denied shell call in the result of the turn without reading `raw`.
- A headless parent and an interactive parent see the same field on a worker or reviewer turn.
- The flag misses a denial that the model does not repeat in its text (decision 5). Matching on a tool event needs a live capture of the denial stream.
- A worker prompt that asks for a validation command can still go unmet on Copilot. The parent decides what to do with the flag.
- The orchestrator already treats `copilot` as unable to run `role wait-checks` for the same reason (`src/prompts/orchestrator.mjs`).

## Alternatives

1. **`--allow-all-tools`**: rejected. It lifts every tool prompt, including write and network tools, and the issue asks for no broad flag.
2. **A scoped `--allow-tool 'shell(<command>)'` flag**: rejected for now. The runtime cannot know the validation commands of a task, and no live run records that the flag form runs a command under the runtime arguments. Not verified.
3. **Fail the turn on a denial**: rejected. It discards edits the turn made, and the denial text alone is too weak a signal to charge a failed turn.
4. **Document only**: rejected. Acceptance requires that a denied call shows in the result.

## Authors

Andro Marces

## Links

- [Pull request #724](https://github.com/andromarces/agent-loops/pull/724)
- [Issue #713: A Copilot worker turn is denied shell commands that the worker contract requires](https://github.com/andromarces/agent-loops/issues/713)
- [ADR 0014: Extend the step budget of a live run](0014-extend-the-step-budget-of-a-live-run.md)
- Implementation: `runCopilot` in `src/agents/copilot.mjs`, `invoke` and `runChild` in `src/runtime.mjs`, `dispatchPayload` in `src/role.mjs`, `resultPrompt` in `src/prompts/orchestrator.mjs`, and the worker preamble in `src/prompts/worker.mjs`. The rule is also stated in `docs/orchestrator-instructions.md` and the README.
- Live checks not verified: a scoped allow flag under the runtime arguments, the Copilot event that reports a denial, and a Windows host.
- [ADR Index](README.md)
