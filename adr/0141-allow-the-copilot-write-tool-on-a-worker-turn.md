# 0141. Allow the Copilot write tool on a worker turn

## Status

accepted

Partially supersedes [ADR 0035: State that a Copilot worker cannot run shell commands and flag a denied call](0035-state-that-a-copilot-worker-cannot-run-shell-commands-and-flag-a-denied-call.md) decision 1. Decisions 2 to 5 of ADR 0035 hold, and both ADRs record the partial supersession.

## Date

2026-11-13

## Context

The Copilot adapter passes `--session-id <id> -s --no-ask-user --output-format json` and no allow rule (`src/agents/copilot.mjs`). Copilot asks before it creates or modifies a file. The runtime sends the prompt on standard input with no terminal. The CLI answers a permission request that no allow rule approves with a denial. ADR 0035 decision 1 accepted that gap, and decision 3 assumed that a turn still finishes useful edits.

Issue #1916 asked whether the file edit tool can write under the runtime arguments. Three live worker turns on 2026-11-13 recorded the answer. The host was macOS 27.3 (build 26C5035r, arm64) with Node v27.0.0-alpha.0.1.0. Each turn ran through `role dispatch` in a fresh disposable Git repository with `--worker copilot`, a fresh `--parent-session`, and `--max-steps 2`. The task asked only for `note.txt` in the repository root with the line `hello`. The `session.start` and `assistant.message` events named the executed model `mai-code-1.1-flash`.

- Turn 1 used GitHub Copilot CLI 1.0.110-3 with no allow rule. The `create` tool was denied with `{path, file_text}` arguments, and a `bash` write command was denied. `permission.completed` held the result kind `denied-no-approval-rule-and-could-not-request-from-user` for both. `note.txt` did not exist after the turn. The envelope carried no `shellDenied`, because the final assistant text paraphrased the denial.
- Turn 2 used GitHub Copilot CLI 1.0.111-0 with `--allow-tool write`. The `create` tool succeeded with no `permission.requested` event, and `note.txt` held `hello`.
- Turn 3 used GitHub Copilot CLI 1.0.111-0 with no allow rule. The `create` tool was denied with the same result kind, and `note.txt` did not exist.

The CLI auto-updated from 1.0.110-3 to 1.0.111-0 between turns 1 and 2, so turn 3 repeated the no-rule case on the newer version. The only difference between turns 2 and 3 was the `--allow-tool write` argument.

## Decision

1. A Copilot turn that is not read-only passes `--allow-tool write`. This rule grants the file create and modify tools, and it grants no shell command.
2. A reviewer turn and an orchestrator turn stay read-only and keep `--deny-tool write`.
3. No shell allow rule is added. ADR 0035 decisions 2 to 5 hold, so a Copilot worker turn still cannot rely on a shell command.
4. ADR 0035 decision 1 no longer holds for a worker turn. Its `--allow-all-tools` rejection stands.

## Consequences

- A Copilot worker creates and modifies files under the runtime arguments on CLI 1.0.111-0.
- The rule is not scoped by path, so it matches a write anywhere that the CLI can access. The default CLI access is the work tree and the system temp directory.
- A shell write stays refused. An unscoped `write` rule approves a shell command's redirection into a file, and not the command. A shell write still needs a shell rule.
- `shellDenied` still covers a shell denial that the assistant text repeats. Turn 1 recorded a write denial in `tool.execution_complete` that the text paraphrased, so the envelope carried no field then. That is the ADR 0035 decision 5 limit.
- A worker that runs a validation command still needs the parent or another CLI, as ADR 0035 decision 2 states.

## Alternatives

1. **`--allow-all-tools`**: rejected. It lifts every approval, including shell, network, and write, and the need is one tool.
2. **`--allow-tool 'write(<path>)'`**: rejected. The adapter cannot know the paths that a task edits, and the CLI already limits file access to the work tree and the temp directory.
3. **Document only**: rejected. The worker contract needs file edits, and the acceptance asks for observed behavior or a flags change.
4. **Fail the turn on a denial**: rejected. It charges a failed step and hides the edits that a turn completed.

## Authors

Andro Marces

## Links

- [Issue #1916: Check whether a Copilot worker can write files under the runtime arguments](https://github.com/andromarces/agent-loops/issues/1916)
- [Pull request #1923](https://github.com/andromarces/agent-loops/pull/1923)
- [Issue #710: Verification checklist: live runs](https://github.com/andromarces/agent-loops/issues/710)
- [Pull request #1912](https://github.com/andromarces/agent-loops/pull/1912)
- [ADR 0035: State that a Copilot worker cannot run shell commands and flag a denied call](0035-state-that-a-copilot-worker-cannot-run-shell-commands-and-flag-a-denied-call.md)
- Implementation: `runCopilot` in `src/agents/copilot.mjs` and tests in `tests/agents/copilot.test.mjs`. Documented in [Supported agents](../docs/reference/architecture.md#supported-agents).
- [ADR Index](README.md)
