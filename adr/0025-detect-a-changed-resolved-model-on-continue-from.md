# 0025. Detect a changed resolved model on --continue-from

## Status

accepted

Narrows [ADR 0023: Restore the headless gate state on a continued run](0023-restore-the-headless-gate-state-on-a-continued-run.md) decision 2 and its accepted gap about a changed default model. ADR 0023 stays `accepted`. Every other decision of ADR 0023 holds.

## Date

2026-10-07

## Context

`--continue-from` compares the recorded role model and effort exactly (ADR 0023 decision 2). The transcript records the model the caller requested. An omitted model, and an alias such as `opus`, resolve inside the CLI. A change of that default or alias target between the two runs went undetected, and the continued run resumed a session under another model (issue #394).

A probe of the five CLIs on macOS shows which outputs name the resolved model:

| CLI      | Output that names the model                                                | Used                                    |
| -------- | -------------------------------------------------------------------------- | --------------------------------------- |
| claude   | `modelUsage` keys of the `--output-format json` result                     | yes, when exactly one key               |
| copilot  | `data.model` of each `assistant.message` event of `--output-format json`   | yes, the last message                   |
| codex    | none: the `--json` events carry the thread id and usage only               | no                                      |
| agy      | none: the `--output-format json` result carries the conversation and usage | no                                      |
| opencode | none in a normal stream: the model appears only inside a provider error    | no (already stated in the adapter note) |

## Decision

1. An adapter that reads a resolved model from its output sets `state.resolvedModel` after a successful turn. The Claude adapter sets it only when `modelUsage` has exactly one key, because more keys mean a subagent or helper model ran too and the role model is then unknown. The Copilot adapter sets it from the last `assistant.message` event that names a model. A turn that reports none keeps the earlier value. The role objects hold the field, so the transcript `roles` record it. A role of Codex, agy, or opencode records none.
2. `restoreSessions` copies a recorded `resolvedModel` to the new role, so a role that does not run in the continued run keeps the record for the next continuation.
3. After `restoreSessions` and before any turn, `verifyResolvedModels` runs one read-only probe turn per role that has a recorded `resolvedModel`. The probe uses the role kind, model, and effort of the new run, in a new session, never the continued one, in `--cwd`, with the `--timeout` bound. The run is refused with exit 1, and writes no transcript, when the probe resolves a model that differs from the recorded one. The message names the role and both models.
4. A probe that reports no model passes with a warning, because nothing can be compared. A probe that fails refuses the continuation, because the model is then unverified. A transcript written before this change records no `resolvedModel`, so it continues as before.

## Consequences

- A continuation of a role on Claude or Copilot costs one extra model call per such role. Each call starts a session that the CLI keeps in its own session list.
- A role on Codex, agy, or opencode is still not checked for a changed default model. **Accepted gap:** these CLIs report no resolved model in their machine-readable output, so no check can read it. Pass an explicit `--<role>-model` in both runs to pin it. An explicit model that is an alias is checked only on Claude and Copilot.
- A Claude turn that reports several models in `modelUsage` records none, so a role whose turns always do is not checked.
- The probe runs before `assertGitWorkTree`, so it can run in a `--cwd` that is not a Git work tree. The run then fails at the later check, after the probe.
- The probe is not interruptible by SIGINT. The `--timeout` bound ends it.
- **Unverified:** the probe ran on macOS with the installed Claude Code and Copilot CLI only. A Windows run and other CLI versions are not verified.

## Alternatives considered

1. **Compare after the first turn of each role**: rejected. The turn has already resumed the session under the changed model, so the check could only report it.
2. **Record every key of `modelUsage`**: rejected. A helper or subagent model that changes would refuse a continuation that the role model does not need to block.
3. **Read the CLI default from its configuration file**: rejected. It needs per-CLI knowledge of configuration layers and of the account default, and cannot resolve an alias.
4. **Skip the probe and record only**: rejected. A record that nothing compares does not meet the issue.

## Authors

Andro Marces

## Links

- [Issue #394: Detect a changed default model on --continue-from](https://github.com/andromarces/agent-loops/issues/394)
- [ADR 0023: Restore the headless gate state on a continued run](0023-restore-the-headless-gate-state-on-a-continued-run.md)
- Implementation: `verifyResolvedModels` and `restoreSessions` in `src/lib/continuation.mjs`, `--continue-from` in `src/cli.mjs`, and `resolvedModel` in `src/agents/claude.mjs` and `src/agents/copilot.mjs`; tests in `tests/lib/continuation.test.mjs`, `tests/cli.test.mjs`, `tests/agents/claude.test.mjs`, and `tests/agents/copilot.test.mjs`; documented in `README.md`
- [ADR Index](README.md)
