# Architecture and supported agents

Run a task loop across several CLI coding agents using a hybrid orchestrator model.

```text
               +-------------------------------------------------+
               |                  Orchestrator                   |
               | (decides next action: worker, reviewer, finish) |
               +-------------------------------------------------+
                                       ^
                                       | action / result
                                       v
               +-------------------------------------------------+
               |              Deterministic Runtime              |
               | (enforces step budget, timeout, read-only check)|
               +-------------------------------------------------+
                               /                 \
                              /                   \
                             v                     v
                 +-------------------+     +-------------------+
                 |      Worker       |     |     Reviewer      |
                 | (modifies / tests)|     |    (read-only)    |
                 +-------------------+     +-------------------+
```

An LLM orchestrator directs the task by choosing discrete structured actions, while a deterministic Node.js runtime enforces safety invariants, step budgets, process lifecycles, and mutation boundaries.

## Architecture

- **Orchestrator**: Evaluates task status, worker findings, or reviewer feedback, and returns a validated JSON action (`run_worker`, `run_reviewer`, `finish`, `abort`). It never edits files or executes subshells directly, with one exception: on a run that ends with `--require-ci`, it may read the pull request check status with `agent-loop role wait-checks`, and that status read is the only command the exception covers.
- **Worker**: Executes the task, modifies files, and runs validation commands in the target repository.
- **Reviewer**: Evaluates the repository state and tests. It must not change a tracked file, an unignored untracked file (a cache included), or Git state; writes only to ignored paths or temporary files outside the repository are allowed. Its CLI runs read-only, except a Codex reviewer, which runs with no sandbox by default and can opt in to `read-only` or `workspace-write`. The mutation check wraps every reviewer turn.
- **Deterministic runtime**:
  - Enforces step limits (`--max-steps`, default 20) and timeout boundaries.
  - Spawns agents, manages persistent sessions, and captures process signals (`Ctrl+C` exits 130).
  - Enforces non-mutating safety on reviewer and orchestrator turns using CLI flags (except for a Codex reviewer with no sandbox) and pre/post Git work-tree mutation detection.
  - Recovers from malformed JSON via a single repair turn.
  - Enforces the completion rule with `--require-accept`: after a worker turn, a `finish` needs a later reviewer `verdict: accept` with a `Checks` line on that state; with no worker turn, it needs at least one reviewer report. A `--mode review-only` run refuses the flag and applies the reviewer turn with no flag of its own: the interactive path reaches it because its init dispatch is the reviewer turn, and the headless path refuses a finish until a reviewer turn has run, whatever that turn returned. The gate is on that dispatched turn, not on a report, an accept, or a readable verdict. The gate follows turn order only, so an edit made outside the loop after the accept is not detected.
  - Resolves the PR head in the runtime with `--require-ci <pr>`, the same gate the interactive `role finish` uses, so a headless PR run no longer depends on the parent reporting the compare. It refuses a finish that also sets `unresolvedCompare`, and it reads the reviewed state of the last reviewer turn, so a worker turn after that review refuses the finish.
  - Declares a run PR-shaped with `--pr <pr>`, so a run that states its PR can only end through the `--require-ci <pr>` gate for that same PR. A finish with no gate is refused, and a finish that sets `unresolvedCompare` is refused with it. `--pr <n>` with `--require-ci <m>` for another pull request is a usage error at parse time, because both flags arrive on one command line, so that run never starts. The gate flag is a run input, so no turn supplies it and the refusal ends the run. A base branch with no required check does not refuse the declaration when every required-check source stated that it holds none: the gate passes on the PR head, the clean reviewed tree, and the merge state, and records it (issue #302, issue #336).
  - Runs an optional `--test-cmd <command>` before each reviewer turn, in the runtime and outside the reviewer sandbox, so a reviewer in a sandboxed mode holds test evidence it may not be able to produce: the exit code and an output tail go to the reviewer prompt as advisory, untrusted evidence. See [ADR 0017](https://github.com/andromarces/agent-loops/blob/main/adr/0017-run-a-test-command-before-each-reviewer-turn.md).
  - Runs a Codex reviewer turn with no sandbox by default (`sandbox_mode="danger-full-access"`, [ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md)), so the reviewer can run the test suite and `gh pr checks`. `--reviewer-sandbox read-only` or `workspace-write` (alias `--reviewer-workspace-write`) selects a sandbox instead. In the sandboxed modes the shell commands that the sandbox runs have network off, and a user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception, as [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md) states. The orchestrator stays read-only in every mode. With no sandbox, the mutation check is the only edit guard, and it detects a change instead of preventing it. It does not see a write outside the repository or a remote write. The mode is recorded at init and kept by `--continue-from`.
  - Pins `AGENT_LOOP_RUNS_ROOT`, `AGENT_LOOP_TEST_SLOTS_ROOT`, and `AGENT_LOOP_SESSION_RECORDS_ROOT` to the paths that it resolves for every worker and reviewer spawn, unless the user set them ([ADR 0049](https://github.com/andromarces/agent-loops/blob/main/adr/0049-pin-the-machine-wide-roots-for-every-child-turn.md)), so a `TMP` override in a turn cannot move the test-slot directory.
  - Runs each Codex turn with a private temporary directory ([ADR 0047](https://github.com/andromarces/agent-loops/blob/main/adr/0047-give-each-codex-turn-a-private-temporary-directory.md)), because the CLI leaves two empty `.tmp*` directories in its own on every turn. The runtime creates the directory with a short `al-` name under the inherited temporary directory and sets `TMPDIR`, `TEMP`, and `TMP` to it. It also lists the inherited directories in `AGENT_LOOP_INHERITED_TMPDIR`, as a JSON array of absolute paths that the parent resolves.
  - Removes the turn directory with a helper process that acts only on the directory with the recorded device and inode. The helper ends at a 30-second bound. A replacement loses at most an empty directory, and a refused, failed, or killed removal only warns. A value of `AGENT_LOOP_INHERITED_TMPDIR` that is present but not a valid list makes the installer refuse every root. The device and inode check is not verified on Windows (#709).
  - Records validated orchestrator actions, a `refusal` event for each finish a `--require-accept` or `--require-ci` gate refused and for each `run_worker` action a `--mode review-only` run refused, an `unresolved-compare` event for each finish that reports an unresolved PR-head compare, a `no-required-checks` event for each finish the `--require-ci` gate passed on a base branch with no required check, child results, one `invocation` event per CLI call with usage when the adapter exposes it, timestamps, exit code, and error when `--transcript` is provided. Raw orchestrator responses are not recorded.

See [Architecture Decision Records](https://github.com/andromarces/agent-loops/blob/main/adr/README.md) for background and architectural decisions ([ADR 0001](https://github.com/andromarces/agent-loops/blob/main/adr/0001-hybrid-orchestrator-runtime.md), which [ADR 0019](https://github.com/andromarces/agent-loops/blob/main/adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md) supersedes, and [ADR 0038](https://github.com/andromarces/agent-loops/blob/main/adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md), which partially supersedes ADR 0019, and [ADR 0002](https://github.com/andromarces/agent-loops/blob/main/adr/0002-harness-neutral-orchestrator-instructions.md)).

## Supported agents

The controller supports these CLI names:

- Claude Code: `claude`
- Codex CLI: `codex`
- Antigravity CLI: `agy` (alias: `antigravity`)
- OpenCode: `opencode` (OpenCode v2, npm `@opencode/cli`)
- GitHub Copilot CLI: `copilot`

Each adapter manages its own persistent session across turns. Model and effort arguments pass through to the CLI on every turn.

A Copilot worker turn can be refused a shell command, so it cannot be relied on to run a validation command (issue #713, ADR 0035). The adapter passes `--no-ask-user` and no allow flag, and Copilot answers a shell call with `Permission denied because no interactive user response was available.` Two live worker turns on Copilot CLI 1.0.96-2 (macOS 27.2) were refused `bash <script path> <args>`, and the command did not run. When the assistant text of a worker or reviewer turn holds that denial, the `role dispatch` envelope of the turn adds `"shellDenied": true`, the headless result prompt that the orchestrator receives carries the same field, and the turn stays `ok`. A turn with no denial text carries no field, so a later turn clears it. An orchestrator turn never carries it. A denial that the text does not repeat is not flagged. The worker prompt tells a worker to name a refused command in `Checks` and `Blockers`. The parent must run the validation itself, or choose another worker CLI, when a task needs a command run. Not verified: a scoped `--allow-tool` flag under the runtime arguments, the Copilot event that reports a denial, and a Windows host.

### Closing block recovery

The parent reads the closing block of the turn. A child can answer a late event after its block, so the last message of the turn can hold no block. Each adapter selects the message that governs:

- A closing block attempt is a report label (`Conclusion`, `Why`, `Blockers`, `Checks`, `Notes`, `Deferred`) or `Verdict`, in any case, anywhere in a message, followed by optional emphasis marks or whitespace and a colon. Any form counts, parsed or not.
- Codex and Copilot: the adapter returns the last message that holds an attempt, alone, and falls back to the last message when none does. A later malformed block wins and surfaces through `raw`, so an earlier accept never overrides it.
- OpenCode: the adapter groups text parts by `part.messageID`, joins the parts of one message unchanged, and starts each other message on its own line. The last closing block governs alone, and the join drops every earlier message with an attempt.
- OpenCode fails the turn with an error, and no accept can come from it, when the order is ambiguous: the position spans of two messages with an attempt overlap, or the unidentified message (every part without a valid, non-empty string `messageID`) governs, yields accept, and spreads its label lines over more than one part. The error holds the redacted text of every message (ADR 0017), cut to its last 4000 code units with a line that states the cut.
- A late bare `Verdict: accept` after a full block gives an unparseable report with verdict `unknown` and no `Checks` line, so the `--require-accept` gate refuses.
- Claude Code and Antigravity CLI return one final result, so the adapter cannot recover the earlier block. A late answer replaces the report of the turn. The worker prompt rule against a background watcher and for a closing block of the whole turn is the only guard.

The live checks and the history of this rule are in issues #449, #458, #461, #467, #493, #494, #509, #510, #529, #639, and #710.

### OpenCode model default

With `opencode` and no `--<role>-model`, the adapter passes no `--model` argument. OpenCode uses the configured `model` when it is enabled and its provider is available in the project; otherwise it falls back to the newest available supported model. A model already selected for a session takes precedence over the configured default. The resolved model is machine- and project-dependent, so it varies by configuration, authentication, and session history. `opencode session export <id>` names the model that ran.

An explicit `--<role>-model` passes through unchanged, with no variant appended. `--<role>-effort` applies to an explicit model and reaches the CLI as `<model>#<effort>`. An effort without a model is rejected, because the installed CLI accepts a variant only inside `--model provider/model#variant`.

`--<role>-model` and `--<role>-effort` record what the caller requested, not the effective model. For an explicit model, the adapter logs the effective `model#effort` it passes. For an implicit default, the adapter logs that OpenCode selects the model and names none; `opencode session export <id>` records the model that ran, and the adapter records it as `resolvedModel` for `--continue-from` (ADR 0026).
