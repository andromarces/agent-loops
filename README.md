# Agent Loops

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
- **Reviewer**: Evaluates the repository state and tests in read-only mode.
- **Deterministic runtime**:
  - Enforces step limits (`--max-steps`, default 20) and timeout boundaries.
  - Spawns agents, manages persistent sessions, and captures process signals (`Ctrl+C` exits 130).
  - Enforces non-mutating safety on reviewer and orchestrator turns using CLI flags and pre/post Git work-tree mutation detection.
  - Recovers from malformed JSON via a single repair turn.
  - Enforces the completion rule with `--require-accept`: after a worker turn, a `finish` needs a later reviewer `verdict: accept` with a `Checks` line on that state; with no worker turn, it needs at least one reviewer report. A `--mode review-only` run refuses the flag and applies the reviewer turn with no flag of its own: the interactive path reaches it because its init dispatch is the reviewer turn, and the headless path refuses a finish until a reviewer turn has run, whatever that turn returned. The gate is on that dispatched turn, not on a report, an accept, or a readable verdict. The gate follows turn order only, so an edit made outside the loop after the accept is not detected.
  - Resolves the PR head in the runtime with `--require-ci <pr>`, the same gate the interactive `role finish` uses, so a headless PR run no longer depends on the parent reporting the compare. It refuses a finish that also sets `unresolvedCompare`, and it reads the reviewed state of the last reviewer turn, so a worker turn after that review refuses the finish.
  - Declares a run PR-shaped with `--pr <pr>`, so a run that states its PR can only end through the `--require-ci <pr>` gate for that same PR. A finish with no gate is refused, and a finish that sets `unresolvedCompare` is refused with it. `--pr <n>` with `--require-ci <m>` for another pull request is a usage error at parse time, because both flags arrive on one command line, so that run never starts. The gate flag is a run input, so no turn supplies it and the refusal ends the run. A base branch with no required check does not refuse the declaration when every required-check source stated that it holds none: the gate passes on the PR head, the clean reviewed tree, and the merge state, and records it (issue #302, issue #336).
  - Records validated orchestrator actions, a `refusal` event for each finish a `--require-accept` or `--require-ci` gate refused and for each `run_worker` action a `--mode review-only` run refused, an `unresolved-compare` event for each finish that reports an unresolved PR-head compare, a `no-required-checks` event for each finish the `--require-ci` gate passed on a base branch with no required check, child results, one `invocation` event per CLI call with usage when the adapter exposes it, timestamps, exit code, and error when `--transcript` is provided. Raw orchestrator responses are not recorded.

See [Architecture Decision Records](adr/README.md) for background and architectural decisions ([ADR 0001](adr/0001-hybrid-orchestrator-runtime.md), [ADR 0002](adr/0002-harness-neutral-orchestrator-instructions.md)).

## Supported agents

The controller supports these CLI names:

- Claude Code: `claude`
- Codex CLI: `codex`
- Antigravity CLI: `agy` (alias: `antigravity`)
- OpenCode: `opencode` (OpenCode v2, npm `@opencode/cli`)
- GitHub Copilot CLI: `copilot`

Each adapter manages its own persistent session across turns. Model and effort arguments pass through to the CLI on every turn.

### Session resume after a failed turn

A failed first turn keeps its session. When the CLI reported a session id, the adapter stores it on the role state on every failure path, including a non-zero exit, a timeout, and a response-validation failure such as a missing response text, so the next turn resumes that session and the edits the failed turn left. Each adapter selects the reported id by its own rule, then requires the selected id to be a non-empty string. Claude and opencode take the first truthy id in the output, so an empty id is skipped and a later valid id is used, while a truthy invalid id, such as a number or an object, fails the turn. Codex takes the `thread_id` of its first `thread.started` event, and an empty or invalid one fails. Copilot takes the id of its last result event (`sessionId`, or `session_id` when `sessionId` is null or absent), and an empty or invalid one fails. agy reads the `conversation_id` of its one result object, and an empty or invalid one fails. A failed selection stores nothing on a first turn and leaves a resumed turn with its stored id. In every adapter except agy, a resumed turn whose selected id differs from the stored id raises `resumeMismatchError`. agy has no mismatch check: a successful resumed turn stores the valid `conversation_id` its result carries, and it logs a warning only when stderr matches `conversation "<name>" not found`. A failed turn never changes the id of a resumed session in any adapter. Every adapter except agy keeps the resumed id or raises `resumeMismatchError` on a different one. agy adopts the `conversation_id` that its successful result carries, even when it differs from the resumed id, and logs a warning only when it resumed an id and stderr matches `conversation "<name>" not found`. A resumed agy turn is sent without the role preamble, so a new conversation that agy started has not received it. The Claude adapter now refuses a different id from a resumed turn, as Codex, Copilot, and opencode already did. The Copilot adapter keeps the id that the result event of a failed first turn reports, and a failed first turn whose output reports no id keeps none. It does not keep the pre-assigned id: a failed turn that reports no id does not show that the CLI created a session under it, and a kept id would send the next worker turn to a session that may not exist, without the preamble. On Copilot CLI 1.0.90-4, a first turn that failed on a bad model printed no result event, and a later call with the same pre-assigned id completed and echoed that id. Whether that call resumed a prior session or started a new one is not verified, and neither is whether the failed turn saved a session.

When a resume fails because the CLI has no such session, the Claude and Codex adapters mark the error, and only for exit 1 without a timeout, cancel, or signal, with empty stdout and stderr that is the one verified line for the requested id, byte for byte, followed by at most one line ending (LF or CRLF). That line ending is the only normalization: leading or trailing spaces, blank lines, a second line, or any other text leave the error unmarked, so a real failure is never rerun. The runtime then clears the id and reruns the turn once as a first turn: a worker gets the role preamble again. The rerun charges no second step. The failed resume ran no model turn, so the step pays for the one requested turn, and the rerun happens at most once per turn. The transcript shows two `invocation` events with the same `stepsUsed`, and the state file keeps one `turns` entry (issue #360, ADR 0016).

Verified on the installed CLIs (Claude Code 2.1.284, codex-cli 0.161.0-alpha.1, OpenCode v0.0.0-dev-20291, agy 1.2.13, Copilot CLI 1.0.90-4):

| CLI        | Resume of a missing session                                                                                                                                                                                                                                                                                                                                                                                            | Session id in the output of a failed first turn                                                                                                                                                                                     | Resume after a kill in the middle of a tool call                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `claude`   | Exit 1, stderr `No conversation found with session ID: <id>`. Triggers the fallback.                                                                                                                                                                                                                                                                                                                                   | An error result printed on stdout carries it. A kill leaves stdout empty.                                                                                                                                                           | Resumed and answered, on a session created with `--session-id`. Not verified for an id the adapter read from output. |
| `codex`    | Exit 1, stderr `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)`. Triggers the fallback.                                                                                                                                                                                                                                                                                 | `thread.started` is on stdout, also after a kill.                                                                                                                                                                                   | Resumed and answered.                                                                                                |
| `opencode` | Exit 0. The CLI creates a session under the given id. No fallback is possible.                                                                                                                                                                                                                                                                                                                                         | The stream carries `sessionID`, also after a kill.                                                                                                                                                                                  | Resumed and answered.                                                                                                |
| `agy`      | Exit 0, stderr `warning: conversation "<id>" not found`, and a new conversation with a new id in the result (probe). The adapter stores the valid id the result carries and logs a warning when stderr matches `conversation "<name>" not found`. A resumed turn carries no preamble, so the new conversation lacks it. A new id without that stderr text is adopted without a warning, and was not seen in the probe. | A non-zero exit that prints a result object with a non-empty `conversation_id` keeps it on a first turn; a bad-model error printed an empty one. A kill at 25 s left stdout empty.                                                  | Not verified: a kill leaves no id to resume.                                                                         |
| `copilot`  | No missing-session error was seen. A first turn with a fresh random `--session-id` echoed that id. After a failed first turn (bad model) that printed no result event, a later call with the pre-assigned id completed and echoed it. Whether it resumed a prior session or started a new one is not verified. No fallback applies.                                                                                    | The adapter keeps the id that the result event of a failed first turn reports. A bad-model failure printed no result event, so it keeps none. The pre-assigned id is not kept (see above), and a resumed turn never changes its id. | Not verified.                                                                                                        |

The OpenCode adapter passes `--standalone` on every turn. The turn runs against a private server instead of the shared background service, so the run does not depend on a background `opencode` service. Provider variables set on the shared service with `opencode service set env` do not apply to a standalone turn; provide them in the process environment. See [Background service](https://opencode.ai/v2/docs/cli#background-service) in the OpenCode CLI docs.

The stream splits one response across several `text` parts, and the adapter concatenates them with no separator. The join inserts a line break before a part that opens a report label (`Conclusion:`, `Why:`, `Blockers:`, `Checks:`, `Notes:`, `Deferred:`), because the parser matches each label plain at column 0 and a glued label makes the whole block unparseable, so `raw` carries the response instead (issue #316). Every other part joins with no line break, so a part boundary inside a sentence, or before the reviewer's `Verdict:` line, keeps the text as the model wrote it. A model that writes a `Verdict:` line after prose without a line break of its own therefore yields `verdict: unknown`.

### OpenCode model default

With `opencode` and no `--<role>-model`, the adapter passes no `--model` argument. OpenCode uses the configured `model` when it is enabled and its provider is available in the project; otherwise it falls back to the newest available supported model. A model already selected for a session takes precedence over the configured default. The resolved model is machine- and project-dependent, so it varies by configuration, authentication, and session history. `opencode session export <id>` names the model that ran.

An explicit `--<role>-model` passes through unchanged, with no variant appended. `--<role>-effort` applies to an explicit model and reaches the CLI as `<model>#<effort>`. An effort without a model is rejected, because the installed CLI accepts a variant only inside `--model provider/model#variant`.

`--<role>-model` and `--<role>-effort` record what the caller requested, not the effective model. For an explicit model, the adapter logs the effective `model#effort` it passes. For an implicit default, the adapter logs that OpenCode selects the model and names none; the OpenCode session metadata records the model that ran.

## Requirements

- Node.js 22 or later
- Git (the target `--cwd` must be inside a Git work tree)
- Installed and authenticated CLI agents

pnpm is required only for development in a clone, not for a registry install.

## Install

Install the CLI globally:

```bash
npm install -g @andromarces/agent-loops
# or
pnpm add -g @andromarces/agent-loops
```

Set up the harness entry points and parent guards at user scope:

```bash
agent-loop install
```

`install` detects the harness CLIs on `PATH`, preselects them, and writes the
entry point and guard for each selected harness. It is interactive; pass
`--harness <list> --yes` for scripts, and `--dry-run` to print the planned
writes without changing anything. A second run with the same package makes no
change. `agent-loop uninstall` removes only the files and settings entries the
install recorded, and restores a file that install changed when the file is
otherwise unchanged. Install applies a harness guard before its entry point, and
if a write fails part way through it records the writes that completed, so
`uninstall` still removes or restores them. It leaves a target in place when it
cannot remove or restore it safely; see [Uninstall skips](#uninstall-skips).

`install` must run from an install whose package location survives an upgrade: a
global install, a project install, or a linked clone. It writes the package
location as an absolute path into every entry point and guard, and `npx` and
`pnpm dlx` place the package in a cache directory that npm or pnpm can delete.
When it detects its own package root inside that cache, `install` refuses with a
message that asks for a global install first, so it never writes a path that can
disappear. `uninstall` reads only the manifest and the harness files, so it still
removes them after the package is gone.

A pnpm install resolves the package into a version-named virtual store entry, so
the resolved path does not survive an upgrade. `install` writes the
version-independent path instead, and checks that the path it writes resolves to
the installed package before using it.

- A pnpm 12 global install puts the store entry in an install directory and keeps a
  hash-named symlink beside that directory, which the `agent-loop` bin shim calls, so
  `install` writes it.
- A pnpm 10 install puts its store directory beside the `node_modules` it links the
  package under, which `pnpm root -g` reports, so `install` writes that link.
- A pnpm 12 project install links the package from a global store whose path names
  no project, so `install` writes the project link instead, which the bin shim calls.
  The project `node_modules/.pnpm` directory holds no store entry there.

An upgrade repoints every one of them. An npm global install, a clone, and a linked
package have no version in their root and render unchanged, and so does any layout
with no link that resolves to the package. See [Upgrade](#upgrade) for the step
after an upgrade.

```bash
agent-loop install --harness claude,codex --yes
agent-loop uninstall
```

### Upgrade

Upgrade the package, then run `install` again with the same harness list:

```bash
npm install -g @andromarces/agent-loops@latest
# or
pnpm add -g @andromarces/agent-loops@latest
agent-loop install --harness <list> --yes
```

Run the second command after every upgrade. It makes no change when nothing
changed, so it is safe to run when unsure. It is required when:

- The upgrade starts from 0.3.0 or 0.4.0, the releases that have `install`, and the
  package sat in a pnpm install listed above (a pnpm 10 or pnpm 12 global or project install). Those versions
  wrote the resolved, version-named pnpm store path, which an upgrade deletes. The
  installed files keep naming that directory until `install` runs again, including
  for a pnpm 12 project install (#311). An npm global install, a clone, and a linked
  package wrote a path with no version, so this case does not apply to them.
- A release adds or changes harness files, for example a new hook or a changed entry
  point. Those files reach a harness only through a new `install`.

When a hook command changes, Codex asks for a new trust step. Run `/hooks` in Codex
to review and trust the changed hook.

### Uninstall skips

`agent-loop uninstall` prints one line per target as
`<harness>: <action> <path> (<detail>)`. A target that it cannot remove or
restore safely reports `skip`, stays on disk, and loses its manifest record:
uninstall deletes the harness record, and removes the manifest when no harness
remains. Uninstall never retries a skipped target, and a backup file can remain
on disk with no record. Recover a skipped target by hand.

`install` writes a backup at `<file>.agent-loops-backup` when the target existed
before install and install changed it, and uninstall reads that file to restore
the pre-install bytes. Install writes no backup when the target did not exist
before install, and none when it already held the installed bytes.

| Reported detail                                    | Target   | What stays on disk                                                   | Manual recovery                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owned file changed since install; left unchanged` | file     | The file, with your later edits, and a backup when present           | Restore `<file>.agent-loops-backup` over the file when that backup exists and you want the pre-install content, or delete the file when you do not want it. Delete the backup by hand when it stays behind.                                                           |
| `backup missing; left unchanged`                   | file     | The file, unchanged since install, with no backup                    | Install wrote no backup when the file already held the installed bytes, so the file can be your original and needs no change. Otherwise restore the original from version control or another copy, or delete the file when you do not want the installed entry point. |
| `settings do not parse; left unchanged`            | settings | The settings file, still invalid, and a backup when present          | The record is gone, so no later `agent-loop uninstall` retries it. Repair the syntax and remove the recorded entry by hand, or restore `<file>.agent-loops-backup` when that backup exists and your later edits can be discarded. Then delete the backup.             |
| `recorded entry not found; left unchanged`         | settings | The settings file, with no recorded entry, and a backup when present | The recorded entry is already gone. Remove another agent-loop entry by hand when one is present, then delete the backup when it exists.                                                                                                                               |
| `backup missing; left unchanged`                   | settings | The settings file, still holding the recorded entry                  | Remove the recorded entry by hand, or restore the original from version control or another copy. The backup is gone, so none remains to delete.                                                                                                                       |

When a settings file changed after install but still parses and holds the
recorded entry, uninstall reports `remove-entry` instead: it removes only that
entry, keeps your edits, and leaves the result not byte-identical. The backup at
`<file>.agent-loops-backup` stays behind, so delete it by hand when you no
longer need the pre-install copy.

Run it without installing:

```bash
npx @andromarces/agent-loops --help
pnpm dlx @andromarces/agent-loops --help
```

`--help` writes no config, so it runs from the cache. `install` writes config
that points at the package, so it refuses from the cache; see [Install](#install).

Install from a Git URL instead of the registry:

```bash
npm install -g github:andromarces/agent-loops
```

npm 12 disables git fetches by default. On npm 12, pass `--allow-git=all`:

```bash
npm install -g --allow-git=all github:andromarces/agent-loops
```

The `bin` script keeps its `#!/usr/bin/env node` shebang and executable bit, so macOS and Linux link an executable file. npm generates the `.cmd` and `.ps1` shims on Windows, so `agent-loop` resolves in PowerShell and cmd. An `agent-loops` alias points at the same CLI, so `npx @andromarces/agent-loops` and `pnpm dlx @andromarces/agent-loops` resolve it. The command locates its package files relative to the installed script, not `process.cwd()`, so it works from any directory; `--cwd` selects the work tree.

### From a clone (development)

Development uses pnpm and the repository Git hooks. User-scope integrations
point at the package location, so a clone registers its own copy with `npm link`
before `agent-loop install`:

```bash
git clone <repository-url>
cd agent-loops
pnpm install
npm link
agent-loop install
```

`npm link` writes its bin shim to the global prefix bin directory, so that
directory must be on `PATH` for `agent-loop` to resolve. It is the
`npm prefix -g` directory on Windows and `$(npm prefix -g)/bin` on macOS and
Linux.

Entries rendered from a clone point at that clone. After the clone moves, run
`npm link --force` from the new location, then `agent-loop install` again. A
plain `npm link` fails with `EEXIST` on Windows when a shim already exists;
`--force` overwrites the shim.
`pnpm link` is not a supported path: pnpm 12 `link` has no global mode. Without a
link, call the CLI entry directly and quote the repository path so a path with
spaces works:

```bash
node "<repo>/src/cli.mjs" install --harness claude --yes
```

`pnpm agent-loop` still runs the CLI entry from the repository root. The
repository Git hooks run formatting and linting on commit and push; they need
`pnpm install` to have completed, because its `prepare` script installs husky.

## Usage

```bash
agent-loop \
  --orchestrator codex \
  --worker claude \
  --reviewer agy \
  --task "Implement the change."
```

PowerShell:

```powershell
agent-loop --orchestrator codex --worker claude --reviewer agy --task "Implement the change."
```

### Options

```text
--orchestrator <agent>        Agent that directs the loop. Required.
--worker <agent>              Agent that implements changes. Required.
--reviewer <agent>            Agent that reviews the repository (read-only). Required.
--orchestrator-model <model>  Model passed to the orchestrator CLI. Optional.
--orchestrator-effort <level> Thinking effort passed to the orchestrator CLI. Optional.
--worker-model <model>        Model passed to the worker CLI. Optional.
--worker-effort <level>       Thinking effort passed to the worker CLI. Optional.
--reviewer-model <model>      Model passed to the reviewer CLI. Optional.
--reviewer-effort <level>     Thinking effort passed to the reviewer CLI. Optional.
--cwd <directory>             Working directory for the agents. Must be inside a Git work tree. Defaults to current directory.
--task <text>                 Task description. Required.
--mode <mode>                 Loop policy: work-first, review-first, or review-only, the
                              same values `agent-loop role` takes. `review-only` dispatches
                              no worker, so it takes neither `--pr`, nor `--require-accept`,
                              nor `--require-ci`, each refused with the same wording the role
                              path uses. At runtime it refuses a `run_worker` action, and
                              refuses a `finish` until a reviewer turn has run, whatever
                              that turn returned. Off by default, so a run without the flag
                              keeps the current behavior. A repeated `--mode` takes the last
                              value, as every other repeated value flag here does.
--max-steps <count>           Maximum child steps. Defaults to 20. 1 to 9007199254740991.
--timeout <seconds>           Timeout per agent invocation. Defaults to 3600. 0 disables the bound.
--transcript <file>           Record execution transcript to a JSON file.
--verbose                     Enable debug-level lifecycle logging, including snapshot activity.
--require-accept              Refuse finish until a reviewer turn reports on the state, and
                              after a worker turn that reviewer turn accepts with a Checks
                              line. Off by default; a repeated refusal, or a refusal with no
                              step budget left, ends the run.
--pr <pr>                     Declare the run PR work on this pull request. Every finish
                              must end through the --require-ci <pr> gate for the same PR,
                              and a finish that sets unresolvedCompare is refused, because
                              that gate resolves the compare. --pr with --require-ci for
                              another pull request is rejected as a usage error. A declared
                              run with no matching gate cannot finish, and no turn in the
                              run can add the flag. A base branch whose required-check
                              sources each state that it holds none does not refuse the
                              declaration; the gate passes on the PR head, the clean
                              reviewed tree, and the merge state, and records that no
                              required check exists. A private GitHub Free-plan repository
                              still refuses a declared run, so it must omit --pr. Off by
                              default; a run
                              with neither --pr
                              nor --require-ci keeps the unresolvedCompare marker as the
                              only record of an unresolved compare.
--require-ci <pr>             Refuse finish until the runtime resolves the PR head from
                               this pull request: the PR head must match the reviewed
                               commit, the reviewed tree must be clean, the PR must not be
                               behind its base, must have no merge conflicts, must not be
                               blocked, and every required check must have passed on the
                               commit GitHub evaluates. A base branch whose required-check
                               sources each state that it holds none has no check to wait
                               for, so the gate passes on the PR head, the clean reviewed
                               tree, and the merge state, and the run records the absence.
                               Refuses a finish that also sets
                               unresolvedCompare. Off by default; without it the
                               unresolvedCompare marker is the only record of an
                               unresolved compare.
-h, --help                    Show help.
```

A value flag also accepts the inline form `--flag=value`, for example
`--task=-x`, which allows a value that starts with `-`. A boolean flag rejects
the inline form. This applies to every flag, including `--harness` for
`install` and `uninstall`.

## Interactive child dispatch: `agent-loop role`

An interactive parent session (Claude Code, Codex, or any harness with shell access) can dispatch one child turn without spawning a headless orchestrator:

```bash
# First call initializes the run state and dispatches the worker.
agent-loop role dispatch \
  --role worker \
  --cwd /path/to/work-tree \
  --task "Implement the change." \
  --mode work-first \
  --parent-session "$CLAUDE_SESSION_ID" \
  --worker claude --reviewer agy \
  --prompt-file ./prompt.txt

# Later calls read the configuration from the state file.
agent-loop role dispatch --role reviewer --cwd /path/to/work-tree --prompt-file ./review.txt
```

Operations: `dispatch` (default), `finish`, `abort`, `wait-checks`.

- The run state lives at a fixed path derived from the resolved `--cwd` (`<os tmpdir>/agent-loops/runs/<sha256 of cwd, shortened>/state.json`, with `state.lock` beside it). There is no `--state` flag; `AGENT_LOOP_RUNS_ROOT` overrides the root for tests only.
- The init call requires `--parent-session`: the CLI refuses an init without it,
  and refuses an unexpanded placeholder such as `${CLAUDE_SESSION_ID}` or
  `%CODEX_THREAD_ID%`, before any state is written. A run through `role` is
  therefore always guarded; the headless `agent-loop` command is the explicit
  unguarded path.
- The init call registers one session entry per run at `<root>/session-runs/<parent-session>/<cwd hash>` (the state directory name) holding the state file path, so a parent guard hook (#57) can look a run up by session id even when `--cwd` is a different work tree. A later init call from the same session in the same work tree overwrites only its own entry, so simultaneous inits in different work trees each keep their entry and one parent session can drive several runs at once. The guard reads every entry for the session plus the legacy single-path `<root>/sessions/<parent-session>` file; init never writes the legacy file.
- Concurrent runs: `role dispatch` blocks until the child turn ends and prints one envelope. To run several loops from one parent session, interleave one dispatch turn per run and read each envelope before the next dispatch, or run each dispatch as a background shell command where the harness supports it and read each envelope when it completes. Pass each run's `--cwd` on every command; each run ends with its own `finish` or `abort`, and the guard stays engaged while any run is non-terminal.
- Prompts come from stdin by default, or `--prompt-file`. `finish` reads the five-key summary as JSON on stdin; `abort` takes `--reason`.
- `wait-checks --pr <pr> [--cwd <dir>] [--timeout <seconds>]` waits for the required checks of that pull request and prints `{"status": "ok", "pr": 42, "timedOut": false, "checks": [{"name": "ci", "state": "SUCCESS", "bucket": "pass"}]}`. It reads status only, so it writes no run state and needs no init, and it returns inside its own bound: `--timeout` is in seconds, defaults to 300, and refuses 0. The runtime owns the bound because `gh pr checks --watch` takes no timeout and a shell `timeout` is absent on Windows and on macOS without GNU coreutils (issue #329). The bound covers the whole command, not only the reads: it starts at command entry and no step of the command adds time to it. Work-tree validation runs inside the bound, with `assertGitWorkTree` carrying the remaining time to `execa` as `timeout` with `cleanup` and `killDescendants`, so a slow or hung `git` is terminated and a validation that reaches the bound refuses, because a work tree the probe never confirmed is not one the command may read. Every read is limited to the time the command has left, and a read that reaches the limit is stopped and then given five seconds to exit, so the total bound is `--timeout` plus five seconds. The `gh` child is terminated on expiry the same way: `SIGTERM` then `SIGKILL` after one second on macOS, and `taskkill /T /F` over the process tree on Windows. `timedOut: true` means the bound was reached, whether with a pending check or during a read; it is a completed read, and the envelope carries the last check states that were read, so an empty `checks` with `timedOut: true` means no check state was ever read. `childExitUnconfirmed: true` appears only when the five-second ceiling expired with the `gh` child still unaccounted for: the command does not claim an exit it did not observe, and a parent that sees it settles the outstanding `gh` process before starting another wait. The `gh pr checks` exit codes decide the outcome as the reviewer read states them: exit 0 with no pending check listed is settled, exit 8 is pending, and exit 1 is settled only when the output lists a failing required check. Any other exit 1, and any output that is not a check list, exits 1 with `status: "error"` and no check state, so an unresolved read never reads as a pass. Every check item is read as a name plus a `state` or `bucket` the CLI knows; an item carrying no readable state is unresolved, so one item the CLI cannot read cannot settle the wait as a pass. A check that has not started is absent from `checks`, because the command omits it, so an empty list means no required check has reported and the wait continues. `--cwd` must be inside a Git work tree, as it is for `dispatch`.
- The state file records `task`, `mode`, `cwd`, `parentSession`, `maxSteps`, `timeout`, `stepsUsed`, `lifecycle`, `pr` (the declared run PR, or `null`), `roles.{worker,reviewer}.{kind,model,effort,sessionId}` (`roles.worker` is null in `review-only`), `lastDispatch`, and `lastResult`, plus `summary` or `reason` when terminal, `unresolvedCompare` when a finished run recorded an unresolved PR-head compare, `noRequiredChecks` when a gated finish passed on a base branch with no required check, and `resumeDecision` when a maintainer resumed an interrupted run. Updates are atomic (temp file plus rename); exclusive access uses `state.lock` with a stale-lock check on the owner pid.
- Every run keeps a turn history without `--transcript`: `turns` holds one entry per charged step, in order, surviving every later overwrite of `lastDispatch` and `lastResult`. Each entry is `role`, `status`, `verdict`, `head`, and `at`; report and response text stay out. `status` is `ok`, `error`, or `interrupted`, where `interrupted` marks a charged turn whose outcome is unknown and therefore carries no verdict and no head. The call that recovers a run from `dispatched` into `interrupted` runs no child and charges no step; it records the turn the crash left unrecorded, using that turn's `lastDispatch` role and time. A dispatch refused past `maxSteps` bounds the array at `maxSteps` fixed-shape entries. The accepted `--max-steps` range is 1 to 9007199254740991 (`Number.MAX_SAFE_INTEGER`). The CLI refuses a flag outside it, and `dispatch` and `finish` re-check the stored `maxSteps` against the same range before reading the budget and name the field to correct, because a state file written by an earlier version or hand-edited carries the value past the flag check. Every budget a run reads is therefore a safe integer, and the step count always advances by exactly one per charged step. `abort` is exempt: it charges no step and reads no budget, so it still ends such a run, which is the only route to a terminal lifecycle when the stored value is out of range. A new init then starts normally and archives the old state file, so no field has to be hand-corrected.
- Lifecycle values: `active`, `dispatched`, `interrupted`, `halted`, `finished`, `aborted` (terminal: `halted`, `finished`, `aborted`). A turn interrupted between the CLI start and the state write leaves `dispatched` with a dead lock owner; the first call after the crash marks it `interrupted`, exits non-zero, and never repeats the turn, even with `--resume-interrupted`. From `interrupted`, only `abort` or an explicit `dispatch --resume-interrupted` is accepted.
- The lock is fail-closed on ambiguity: a contender that finds a lock it cannot read (created moments ago, content not yet written) exits non-zero and never removes it; only an unparseable lock older than a grace window, or one whose recorded pid is dead, is treated as stale. A dead-pid lock is removed under a claim file `state.lock.reap.<digest>`, a fixed-length name at every nesting depth, keyed by the SHA-256 of the guarded file name and its stale content, that only one contender can create. Each lock and claim records a random nonce with its pid, so the content of every acquisition is unique. The lock is deleted only if it still holds the content that was read as stale, so a lock that a new owner created in between survives, even with the same pid and start time, and the contender exits as busy. A lock written without a nonce by an older version is read the same way and is matched by content alone, so an older-version owner with the same pid and start time in the same millisecond would be taken for the stale lock. This protection holds only when every contender runs this version or later: an older-version contender removes a stale lock without a claim and keeps the original race with any other contender. A contender that finds a live claim exits as busy, and a lock that cannot be re-read is kept. A claim left by a crashed process is removed the same way, under a claim keyed by its own content, and a chain of more than two crashed claims fails closed. Claim files from a crashed process can remain until a later contender hits the same stale lock. Lock creation is an atomic hard link, with an exclusive-create fallback on filesystems that have no hard links (FAT/exFAT, some network mounts); a lock temp file left by a crashed process is pruned on the next acquisition.
- The reviewer turn runs under the same `withMutationCheck` as the headless loop: a detected mutation or snapshot error is fatal, keeps the charged step, and sets `halted`. No further dispatch is possible; the next run needs a new init call, which archives the halted file as `state.<timestamp>.json`.
- `mode: review-only` rejects `--role worker` as a hard guard and does not require `--worker` at init. `finish` is completion of the requested work, not code acceptance: it is accepted from `active` in any mode, and the caller records the reviewer verdict and unresolved findings in the five-key summary, whose content the runtime does not check.
- `--mode <mode>` on the headless `agent-loop` command names the same three values the `agent-loop role` init call takes, so a caller learns the loop policy from one flag on both paths. The headless loop still chooses its own action order, and the flag is off by default, so a run without it behaves exactly as before, down to the byte-identical orchestrator prompt. A repeated `--mode` takes the last value, the way every other repeated value flag on this path already behaves. `--mode review-only` is the one mode that changes what a run accepts: it dispatches no worker, so it takes neither `--pr`, nor `--require-accept`, nor `--require-ci`, and each of those three is refused at parse time before any child turn runs, with the same wording the interactive path uses (`--pr` declares PR work, which needs the --require-ci gate; review-only rejects that gate. and --require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.). A `run_worker` action in that mode is refused at runtime and ends the run on exit 1 with the reason `mode review-only rejects a run_worker action`, the same hard guard the interactive path applies to `--role worker`: no worker turn runs, and no step is charged. `--mode work-first` and `--mode review-first` accept all three flags, and the headless orchestrator prompt states the mode the run was started with. The two paths reach the reviewer turn differently. `agent-loop role finish` in that mode applies no reviewer-turn rule of its own, because every reachable interactive run already has a reviewer turn: the init dispatch is itself that turn. A headless `--mode review-only` run owns its own action order and can reach a finish before any reviewer turn, so the runtime refuses that finish until a reviewer turn has run. That gate requires that a reviewer turn was dispatched, and nothing more: the turn can end in an error, so the finish can carry no reviewer report, no accept, and no readable verdict. The prompt instructs the orchestrator to record the reviewer status and verdict in `verified`; the runtime checks only that each summary key is a non-empty string and does not verify its content. `--require-accept` is refused in this mode on both paths, at `finish` on the interactive path and before the run starts on the headless path, so the headless run applies that reviewer turn with no flag of its own. A transcript records `mode` only when the run named one, so a mode-free run writes the same file shape as before (issue #337).
- `--pr <pr>` on the init call declares that the run's work is delivered on that pull request, so the run can only end through the `--require-ci <pr>` gate for the same PR. A base branch that states it has no required check does not refuse the declaration when every required-check source stated that it holds none: the gate passes on the PR head, the clean reviewed tree, and the merge state, and records it. A private GitHub Free-plan repository still refuses a declared run, so it must omit `--pr`. A `finish` with no gate, or with a gate for another PR, is refused without reading GitHub, because the interactive `--require-ci` arrives only at `finish`, and a `finish` that sets `unresolvedCompare` is refused because the gate resolves that compare. On the headless path both flags are on one command line, so `agent-loop --pr 42 --require-ci 7` is a usage error before the run starts. On the headless path, one refusal names every condition the finish broke, so read all of it rather than the first reason. The interactive `role finish` names every condition above the `--require-ci` gate and reads the gate only after those pass, so a later `finish` can report a `--require-ci` condition that the first refusal did not name. A matching gate applies its own conditions on top of the declaration. The gate flag is a run input, so no `dispatch` supplies it, a repeat `finish` is refused the same way, and such a run can only end through `abort` with the missing gate named in the reason. `--pr` is an init field, so a later call that changes it is refused, a state file written before the field has no `pr` and keeps the marker-only behavior, and `review-only` refuses `--pr` at init because that mode rejects `--require-ci` at finish. A run that declares no PR keeps the accepted gap of issue #286: the runtime has no PR input, so an omitted `unresolvedCompare` marker still reads as a verified finish (issue #302).
- Two opt-in finish gates apply to `work-first` and `review-first`. `--require-accept` refuses a `finish` unless the latest turn is a reviewer `verdict: accept` with a `Checks` line and the current exact snapshot has the reviewed `head` and `digest`, so a change to an uncommitted state at the same commit is detected. `--require-ci <pr>` refuses unless the PR head equals the reviewed `head`, the reviewed tree is clean, the PR is not behind its base under a strict rule, has no merge conflicts, GitHub reports a known and unblocked merge state, and every required check passed on the commit GitHub evaluates; required contexts come from repository rulesets, classic branch protection, and `gh pr checks --required`. An empty set refuses when a configuration source settled nothing, and passes when every configuration source stated that it holds no required check; that pass carries `noRequiredChecks`, so a finish on such a branch stays distinct from one that verified a check (issue #336). The rule for that pass is one allowlist, and it fails closed. Each required-check configuration source is classified by what its reply proved. A ruleset read the gate cannot interpret has the class unknown, and it refuses the finish whatever the rest of the union holds, before the per-check pass, because that reply may carry a required-status rule the gate never saw; that is a failed or partial page, a body that is not a readable array of pages, an anomalous page sequence, which is no page at all, two or more empty pages, or an empty page beside a page that holds rules, and an unlisted or malformed rule type. A ruleset read of exactly one empty page is neither of those: its class is empty, a successful read that found no rule, so it contributes no contexts and the per-check pass runs on the other sources, exactly as origin/main did, so a classic-only repository whose required checks passed still finishes. Otherwise a finish passes on the absence only when no source named a required check and no source is unknown, so both sources must have stated the outcome, and an unknown classic-protection source keeps the empty-union refusal with the reason naming it. An exact list of every reply shape and its class is in [ADR 0012](adr/0012-establish-the-absence-of-a-required-check.md); the classes are absent, has-contexts, empty, and unknown, and the table states each one on both the normal and the relaxed path. Absent, the only class that lets a finish pass, has exactly one reply per source. For repository rulesets it is a read of every page that returns a non-empty array whose entries all carry a documented rule type and none is a `required_status_checks` rule; the read is paginated, so a rule on a later page is enforced rather than missed, and a body the gate cannot account for every page of is unknown. For classic branch protection it is exactly `gh: Branch not protected (HTTP 404)`, one trailing line break aside, which the endpoint writes only to a caller that can read protection. No successful classic-protection body proves an absence, because a classic-protected branch can require reviews without requiring a check, so a readable body that names no check is unknown. Has-contexts is a reply that named at least one required check. Empty is exactly one empty page: a successful read that found no rule, which contributes no contexts and is not a positive absence, so the empty-union refusal names it on the relaxed path. Unknown is every other reply, including a ruleset read of no page at all, a ruleset entry whose type is missing or is not a documented rule type, a malformed or unparseable body, an empty page inside a longer read, and every unreadable reply. A branch reaches the absence path where both sources state the outcome, so a ruleset-only branch does, while a branch with no ruleset at all does not, because its read is one empty page, and empty is not absent, and an empty page inside a longer read states nothing, and neither does a classic-protected branch that requires reviews but names no check. GitHub documents that the ruleset read returns active rules only, so a rule in a ruleset whose enforcement is `disabled` or `evaluate` never appears in it and never affects the classification. `gh pr checks --required` is never classified and never establishes the absence, because it lists only the checks that already reported and on a base branch with no required check it prints nothing, which is the same silence as a read failure. The gate takes required names from its stdout whatever the exit status, so a non-zero exit whose stdout holds that JSON still contributes names, and only a stdout that is not a JSON array of named checks contributes none. The observed replies for the two configuration sources are `Not Found` (404) for a token without repository admin, `Branch not protected` (404) for an admin on a branch with no classic protection, `Resource not accessible by integration` (403) for a `GITHUB_TOKEN`, and `Resource not accessible by personal access token` (403) for a fine-grained PAT without the Administration permission. A rate-limit or SSO 403 fails the run by design, because it matches no unreadable shape and is not read as a source at all. The exception to ruleset readability is a private repository on the GitHub Free plan, where the plan does not allow the rule at all. The Free-plan 403, `Upgrade to GitHub Pro or make this repository public to enable this feature.`, was measured on the classic protection, branch rules, and rulesets endpoints with an admin classic PAT and an admin fine-grained PAT, and a read-capable collaborator was not tested, so whether a non-admin sees the same 403 is unverified. **A private GitHub Free-plan repository still refuses a declared `--pr` run under this change, so this does not resolve #336 for it, and such a repository must omit `--pr`, which leaves the #286 gap in place.** Repository rulesets are readable with read access on a repository whose plan allows the rule, so a token without repository admin still gates through repository rulesets and through `gh pr checks --required` while the classic-protection source stays unknown. A blocked merge state refuses after the per-check pass, so a named check refusal keeps its name, and a required check that never started cannot escape the gate, through that refusal or, when no required check reported and a configuration source is unknown, the empty-union refusal; the gate cannot tell a missing check from an unmet review or another required rule, so a repository with required approvals also refuses until they are met, and a branch that states it has no required check still refuses while its merge state is blocked. A context qualified by an app (a ruleset `integration_id` or a classic-protection `app_id`) passes only on a check run from that app, and an unqualified copy of that name is dropped so it cannot judge the name by another app's run. GitHub computes the merge state lazily, so a retry shortly after a push can clear an `unknown` state. Each refusal names the failed condition. In `review-only`, a flagless `finish` keeps the current behavior and each gate fails with a clear error.
- Live verification of the classic-protection absent-check refusal with a non-admin `GITHUB_TOKEN` is recorded in [PR #285](https://github.com/andromarces/agent-loops/pull/285). The disposable probe repository was deleted after [issue #296](https://github.com/andromarces/agent-loops/issues/296); the recorded result does not depend on it.
- The reviewer prompt carries a fixed review scope on every turn, so a parent prompt that restates the spec does not hide a weakened guard. The rule text for required checks is in every reviewer prompt, and it applies only when the task names a pull request. Then the reviewer reads `gh pr checks <pr> --required` for the reviewed head. The command reads status only, so the reviewer stays read-only. Every rule below belongs to that one condition, and the prompt nests them under it. A failing required check is a blocker. Exit code 8 is a pending check, which goes in `Checks` instead. Exit code 1 covers a failing check, a repository with no required check, and a read error; a blocker is reported only when the output lists a failing required check, and any other exit 1 is unresolved in `Checks`. The command omits a check that has not started, so a read pass covers only the listed checks. The read reflects the PR head on GitHub, so a head that differs from the local reviewed head is reported in `Checks`. When `gh` cannot read the checks, the status is unresolved and goes in `Checks`, and a pass is reported only when the read shows one. `--require-ci` stays the enforcement point; the rule only lets the reviewer see the failure before the gate refuses (issue #313, issue #317). In a run that ends with `--require-ci`, the orchestrator waits for the required checks on the new PR head to complete before it dispatches the reviewer, and before `finish` when a reviewer turn reported a pending check. The wait runs `role wait-checks --pr <pr> --timeout <seconds>`, which the headless prompt renders as a whole command with `--cwd` and the Node binary, the CLI script, and the work tree of the run, so it resolves for a global install, an `npm link`, and a clone run through `node <repo>/src/cli.mjs` or `pnpm agent-loop` without `agent-loop` on `PATH`, and reads the run's repository whatever directory the shell starts in. On Windows it gives a PowerShell form with the call operator `&` and a form for bash or cmd without it, because each shell rejects the other's form. A Node, CLI, or work tree path holding `"`, `$`, a backtick, `%`, `!`, U+201C, U+201D, U+201E, or a control character, or a backslash on POSIX, gets no command, and the prompt names no wait. It is a status read that changes nothing and is the one exception to the orchestrator role rule: a status read is not a review, not a test, and not an edit, and `agent-loop role wait-checks` is the only command it covers. A headless wait runs inside the orchestrator turn, so it is possible only where the orchestrator CLI keeps shell network in a read-only turn: `claude`, `agy`, `opencode`, and `copilot` keep it, and `codex` does not. The orchestrator CLI and the reviewer CLI are chosen independently, so a `codex` orchestrator with a `claude` reviewer is a valid run: there the orchestrator cannot wait, every reviewer turn reads the required checks, and each further reviewer dispatch costs a step. When both CLIs are `codex`, no turn can read the checks and the `--require-ci` finish gate is the only check read, because the runtime applies it outside every read-only turn; the gate refuses a finish while a required check is pending, a refusal itself charges no step, and the reviewer dispatch that corrects it charges one, so the step budget has to cover those dispatches. A turn that outlasts the per-invocation timeout `--timeout`, which defaults to 3600 seconds, ends the run on exit 1 before it returns an action, so the headless prompt states a wait `--timeout` below the turn one: 300 seconds, or half the turn `--timeout` less the five-second child-exit ceiling when that is smaller, so the wait and its child-exit window end inside the turn. A turn `--timeout` under 12 seconds fits no bound, and a path the shells quote differently gives no command; in both cases the prompt names no wait and the `--require-ci` gate is the only check read. A wait that reports `"timedOut": true` left the check pending; the orchestrator does not wait again in the same turn, and dispatches the reviewer or aborts with the pending check named. A `childExitUnconfirmed: true` envelope means a `gh` process may still run, and the orchestrator settles it before another wait (issue #348, ADR 0013). A required check still pending after a wait is not a finish condition, because the gate refuses a finish while it is pending and a finish summary cannot hold it: wait again, dispatch the reviewer again, or abort with the pending check named in the reason (issue #319). A run that declares its PR with `--pr <pr>` needs no reviewer read for that status: the runtime reads the required-check status for the PR head before the turn and supplies it to every reviewer prompt, so a reviewer whose CLI cannot reach the network, such as a sandboxed Codex reviewer, still sees the failure instead of reporting it unresolved. The reviewer's own read stays in the prompt as the fallback, and the prompt tells the reviewer to prefer it when the supplied status is unresolved and to report any difference from the supplied status in `Checks`. The supplied status is evidence, not a gate: `gh pr checks` lists only the checks that already reported. The runtime resolves the PR head first and reports a status only when it matches the local reviewed head, and it reads the head again after the checks, because the two are separate calls and a pull request can advance between them. A mismatch, a moved head, a failed read, a malformed reply, an unexpected exit code, and a stalled read are all unresolved, and every supplied status states the head it describes. The status is advisory evidence that replaces the reviewer's read for that turn, never a verdict: one window survives the re-read, where a head advances away and back within the read and no re-read separates it, so every status carries `advisory: true`, the reviewer keeps its own read as the fallback, and the `--require-ci` finish gate re-reads GitHub and enforces the condition. The read is bounded in time and the bound terminates the child, so a hung `gh` cannot stall a dispatch. The runtime reports the status it read beside the reviewer result, in the dispatch envelope and in the state file, so the parent can compare it with the reviewer `Checks` line. A run that declares no PR reads no status (issue #320).
- The reviewer is required to end with one explicit `Verdict:` line (`accept` or `reject`, parsed case-insensitively) inside its closing block. The verdict word alone, the word closed by a sentence period (`reject.`), or the word followed by a separator and a trailing clause (`reject — the state does not pass`) parses to that word, unless the clause names either verdict as a whole word. Any other malformed value, including a missing line or a line that names both verdicts, yields `verdict: unknown`; process success never implies acceptance.
- `--transcript <file>` appends one JSON line per `invocation` and `result` event, in the same shape as the headless mode, accumulating across calls. It stays a per-call flag; the `turns` array above is the history every run keeps without it.

Stdout carries exactly one JSON envelope; all logs go to stderr:

```json
{
  "role": "reviewer",
  "status": "ok",
  "report": {
    "conclusion": "...",
    "why": "...",
    "blockers": "...",
    "checks": "...",
    "notes": "...",
    "deferred": "..."
  },
  "verdict": "accept",
  "reviewed": {
    "head": "...",
    "clean": true,
    "exact": true,
    "digest": "..."
  }
}
```

`report` is parsed from the closing block every child turn must end with. `conclusion`, `why`, and `blockers` are required; `checks` (the commands that ran and their results), `notes` (non-blocking findings), and `deferred` (out-of-scope items) are optional, and an omitted or empty label yields `null` for that field without making `report` null. Every child turn is asked for a `Checks` line, for a worker turn and a reviewer turn alike (issue #310), but only the reviewer `Checks` line is a gate input, so a worker `Checks` line is reported evidence and never an accept. Each label takes one line, plain at column 0: a list anywhere in the closing block, for example bullets under any label, after the reviewer `Verdict:` line, or a bullet with no space after the marker, an indented label, or a decorated label makes the whole block unparseable, so `raw` carries the text instead of dropping it. This covers a label that already holds a value, including the required `blockers`, and a label occurrence that a later repeat shadows. A non-list line, for example a closing sentence, does not make the block unparseable. A `*` line is not always a list: a `*` line whose closing `*` a letter precedes, where the character right after the close is not a word character or `*`, and where nothing glued from that character on is a letter or an ASCII digit (`*file*`, `*glob src/a*`, `*use a* b`), reads as an emphasis run, so a spaceless `*` bullet of that shape is an accepted gap. The block still parses and every matching line drops with no `raw` signal, the same as any other line that is neither a label nor a list, because the bullet text and the emphasis text are the same bytes. Every other `*` line either is a list and blanks the block, for example `*item`, `* item`, or `*file*.mjs`, or is not a list and drops as prose, for example `**bold** note` (issue #275). When parsing fails, `report` is null and `raw` carries the whole response. `status: "error"` carries `error`, and every error path still prints one JSON object. The subcommand launches no orchestrator model and accepts no `--orchestrator` flags.

A reviewer envelope carries `reviewed`: `{ head, clean, exact, digest }` from the snapshot the runtime takes before the reviewer turn, so the child cannot misreport it. A reviewer turn in a run that declared a PR with `--pr <pr>` also carries `prChecks`: `{ pr, head, status, checks, summary, advisory }`, the required-check status the runtime read for that PR head before the turn, where `status` is `pass`, `failing`, `pending`, or `unresolved`, `checks` names the checks in that state, `head` is the commit the status describes, `advisory` is always `true`, and `summary` is the one-line form the reviewer prompt carries. The state file keeps the same `prChecks` beside the response in `lastResult`, so a parent can compare the runtime read with the reviewer `Checks` line. The read resolves the PR head first and reports a status only when it matches the local reviewed head, and it reads the head again after the checks, because the two are separate calls and a pull request can advance between them. A mismatch, a moved head, a failed read, a malformed reply, an unexpected exit code, and a stalled read are all `unresolved` and never a failed turn. `advisory` is always `true` because one window survives the re-read: a head that advances away and back within the read leaves both head reads naming the same commit while the checks describe the other one, and no re-read separates that. The status is therefore a report, the reviewer treats it as evidence, and the `--require-ci` finish gate re-reads GitHub and enforces the condition. A run that declares no PR carries no `prChecks` (issue #320). `head` is the commit, `clean` is true when the work tree has no uncommitted entries, `exact` is true when every entry has a content hash or is a deletion, and `digest` identifies the uncommitted state. A symlink hashes its link target text with a tag, so two links with different targets have different digests, dangling included, and a link never collides with a regular file that holds the same bytes.

The `finish` envelope is `{ "status": "ok", "lifecycle": "finished" }`, and the command exits 0. A finish that recorded an unresolved PR-head compare adds `"unresolvedCompare": true` and still exits 0, where the headless loop exits 4 for the same condition, and a verified finish keeps the envelope unchanged.

## Interactive orchestrator: harness entry points

An interactive parent session runs the same role rules through the subcommand,
driven by `docs/orchestrator-instructions.md`. One harness-neutral instruction
file defines the role; each supported harness gets a thin entry point that
includes it rather than copying it. Role activation never goes into `AGENTS.md`
or `CLAUDE.md`, because dispatched children read those files; activation
happens only through explicit invocation.

| Harness         | Installed entry point                                  | Invocation                                    |
| --------------- | ------------------------------------------------------ | --------------------------------------------- |
| Claude Code     | `~/.claude/skills/agent-loop/SKILL.md`                 | `/agent-loop <task and role settings>`        |
| OpenCode        | `~/.config/opencode/plugins/parent-guard.ts`           | `/agent-loop <task and role settings>`        |
| Codex CLI       | `~/.agents/skills/agent-loop/SKILL.md`                 | `$agent-loop <task and role settings>`        |
| Copilot CLI     | `agent-loop-copilot` (packaged bin)                    | `agent-loop-copilot <task and role settings>` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/agent-loop/SKILL.md` | `/agent-loop <task and role settings>`        |

`agent-loop install` writes these files from the templates under
`src/install/templates/`, and each rendered entry point points at the installed
`docs/orchestrator-instructions.md` by absolute path, so it works outside a
clone. Each skill renders the CLI by absolute path and runs every `agent-loop`
command in the instructions with that resolved invocation, so a Git Bash session
that cannot resolve the `agent-loop` command still starts a guarded run (#151).
`harness-check` exits 0 for a match, 3 when another harness is the nearest
ancestor, and 1 when the check cannot run or finds no harness ancestor, so the
skill separates a refusal from a check that did not decide. See
[Parent guard details](docs/parent-guard.md) for every guard target.

- The `~/.agents/skills` directory is shared. Copilot CLI and OpenCode also
  discover personal skills there, so the installed Codex skill appears in both.
  The Codex selection owns that directory; install and uninstall for Copilot
  never touch it. The Codex skill sets `metadata.opencode/autoinvoke: false`, so
  OpenCode drops it from the model's skill list and the model cannot auto-invoke
  it for an `/agent-loop` request; the OpenCode plugin command then owns
  `/agent-loop`. The skill also refuses to start a run when the nearest harness
  process is not Codex, so a Copilot or OpenCode session that inherits
  `CODEX_THREAD_ID` cannot start a run through it.
- The Claude Code skill sets `disable-model-invocation: true`, so only the
  maintainer activates it with `/agent-loop`, and it omits `context: fork`, so
  the skill runs in the current session. OpenCode also discovers
  `~/.claude/skills`, so a foreign OpenCode session lists this same copy to the
  model. The skill sets `metadata.opencode/autoinvoke: false`, so OpenCode drops
  it from the model's skill list and the model cannot auto-invoke it for an
  `/agent-loop` request; the OpenCode plugin command then owns `/agent-loop`.
  Before the init dispatch call the skill runs the installed CLI by absolute path
  with `harness-check claude`; exit 3 stops the run because another harness owns
  the session, and any other non-zero exit stops the run because the check could
  not run or found no harness ancestor. Both cover the literal
  `${CLAUDE_SESSION_ID}` that OpenCode leaves unexpanded. The resolved invocation
  then replaces `agent-loop` for the init dispatch and every later command, so the
  run does not need the `agent-loop` command on PATH. Its body passes
  `${CLAUDE_SESSION_ID}` as `--parent-session` on the init dispatch call.
- The OpenCode entry point is a user plugin at
  `~/.config/opencode/plugins/parent-guard.ts`, loaded automatically from that
  directory. Stored command templates expose no session id, so the plugin
  registers the `/agent-loop` command itself: its executor reads
  `CommandInvocation.sessionID` and carries that id into the orchestrator
  prompt, and the init dispatch call passes it as `--parent-session`. The shared
  Claude and Codex skills set `metadata.opencode/autoinvoke: false`, so OpenCode
  drops them from the model's skill list and the plugin command is the only
  `/agent-loop` entry point.
- The Codex CLI skill (`~/.agents/skills/agent-loop/SKILL.md`) activates only
  through `$agent-loop`. Before the init call it runs the installed CLI by
  absolute path with `harness-check codex`, which uses the same exit codes. Exit
  3 means another harness is the nearest ancestor; any other non-zero exit means
  the check could not run or found no harness ancestor. Either stops the run: an
  environment check cannot
  decide it, because a nested harness inherits `CODEX_THREAD_ID`. The resolved
  invocation replaces `agent-loop` for every command in the instructions. The
  skill passes `CODEX_THREAD_ID` as `--parent-session`. Use `$env:CODEX_THREAD_ID` in
  PowerShell and `$CODEX_THREAD_ID` in POSIX shells. In PowerShell, pass
  `--cwd $worktree` after setting `$worktree = (Get-Location).Path`. The CLI
  requires `--parent-session` and rejects an empty or unexpanded value before it
  initializes a run. This
  environment variable is an undocumented dependency and can change on upgrade.
  When it is absent, do not start a guarded run. Run `/hooks` once to review and
  trust the installed user hook; a changed hook command needs a new trust step.
  Do not use `--dangerously-bypass-hook-trust` for normal use.
- The Copilot CLI entry point is the packaged `src/entrypoints/copilot.mjs`,
  exposed as `agent-loop-copilot`. It mints a UUID, starts
  `copilot --session-id <uuid> --add-dir <docs dir> --interactive <prompt>`, and
  includes the instruction file, task, and same id for `--parent-session` in the
  first prompt. The current CLI documentation exposes no custom command-template
  session-id placeholder, so the launcher is the native entry point.
- The Antigravity CLI entry point is a skill at
  `~/.gemini/antigravity-cli/skills/agent-loop/SKILL.md`, activated as
  `/agent-loop` in an interactive session. It runs the installed CLI by absolute
  path with `harness-check antigravity` before the init call, and it replaces
  `agent-loop` with that resolved invocation for every command in the
  instructions. Then it passes
  `ANTIGRAVITY_CONVERSATION_ID` as `--parent-session`; use
  `$env:ANTIGRAVITY_CONVERSATION_ID` in PowerShell. This environment variable is
  an undocumented dependency and can change on upgrade, and child processes
  inherit it. When it is absent, or when the harness check stops the run, do not
  start a run.
- Universal fallback: reference `docs/orchestrator-instructions.md` in the first
  prompt and follow it when the harness entry point is not installed. The
  fallback must still pass the harness session id as `--parent-session`; the CLI
  refuses an init without it. The headless `agent-loop` command is the explicit
  unguarded path.
- On Copilot CLI, the installed `~/.copilot/hooks/parent-guard.json` registers
  PascalCase `PreToolUse`, so the payload carries `session_id` and `tool_name`,
  and the hook prints the flat `permissionDecision` object that Copilot CLI
  consumes. A live probe on Windows with Copilot CLI 1.0.87-0 confirmed the
  repository form of this hook loaded and reported `tool_name: Write`; no macOS
  runtime was available for that change. Copilot reads the shared subset of a
  _repository_ `.claude/settings.json`, which does not cover a Claude user
  guard, so Copilot gets its own user hook file; install never relies on Copilot
  reading the Claude user settings.
- The parent-edit guard (#57) reads `--parent-session` from the run's session
  entry (see [Parent guard details](docs/parent-guard.md)). Every `role` init
  requires `--parent-session`; a legacy state written without one keeps its
  parent unguarded.

## Parent guard: hard read-only for the parent session

The parent rule ("the orchestrator never edits files") is prompt-only, so a drifting parent session can still edit. Five harnesses add a hard guard for the file-edit tools, and all share the decision logic in `src/hook/decision.mjs`. See [Parent guard details](docs/parent-guard.md) for the per-harness matchers, the session-field mapping, and the pre-tool hook availability survey.

## Reviewer safety

Reviewer and orchestrator turns run in read-only mode to prevent unintended repository mutations.

### Read-only CLI flags

| CLI        | Read-only invocation flag     | Flag effect                                                                                                                        | Role-model subagent fan-out                                              | Evidence                              |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `claude`   | `--permission-mode plan`      | Plan mode blocks file edits.                                                                                                       | Yes; Explore and Plan subagents run on the role model. Adapter disables. | Claude docs; issue #46 smoke test     |
| `codex`    | `-c sandbox_mode="read-only"` | Passes read-only sandbox mode on new and resumed sessions. Also blocks network access.                                             | Yes; `spawn_agent` subagents inherit the parent model and effort.        | Codex rollout transcript              |
| `agy`      | `--mode plan`                 | Plan mode disables file edits.                                                                                                     | Yes; `invoke_subagent` subagents inherit the parent model by default.    | CLI `stream-json` step                |
| `opencode` | `--agent plan`                | The plan agent blocks edits; a global permissions allow can cancel it. Adapter denies `edit` per turn. Shell writes stay possible. | Yes; the `subagent` tool inherits the session model. Adapter denies it.  | `run --format json` tool call; A/B    |
| `copilot`  | `--deny-tool write`           | Denies write/edit tools. External permissions may still permit shell writes.                                                       | No; subagents run on an agent-definition default model.                  | `--output-format json` subagent event |

#### Codex read-only network limit

`-c sandbox_mode="read-only"` restricts network access as well as writes. A
Codex orchestrator turn cannot run `gh` to resolve a PR head, so a
Codex-orchestrated PR run must abort, or record the unresolved compare under
`notDone` and `open` with `"unresolvedCompare": true`, instead of finishing as
verified, unless the run carries `--require-ci <pr>`. That gate runs in the
runtime process, which the Codex sandbox does not cover, so it resolves the PR
head without the orchestrator needing network access (#293). A Codex reviewer turn
cannot run `gh` either, for example to check a PR's CI status. Read-only file
protection stays in place on every adapter: the Codex sandbox flag remains, and
the pre/post mutation check still aborts on a detected change. The other
adapters' read-only invocations keep shell network access.

#### Codex read-only child-spawn limit

Direct probe: on 2026-09-29, a `codex exec` run on Windows 11 with codex-cli
0.159.0-alpha.12 and `-c sandbox_mode="read-only"` observed two results. A child
`node` spawn from a Node.js process returned an error. `pnpm test --version`
exited 1 with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` (`Access is denied`).
That probe did not start Vitest.

Reports recorded in issue #342, not re-observed: the reviewer turns of the #301,
#302, #311, and #326 runs, on the same CLI version, mode, and OS, each reported
`Vitest failed at startup (spawn EPERM)`. Some also reported `pnpm` blocked by a
store lock and `oxfmt` failing with `spawn EPERM`. Their reviewer `Checks` lines
therefore excluded the test suite, and the accepts rested on `git diff`, static
checks, and in-process probes. `docs/parent-guard.md` records the same class on
the `workspace-write` path: the unelevated Windows sandbox blocks a child spawn
with `EPERM`.

Not verified: a Codex read-only reviewer on macOS or Linux, and a Codex reviewer
under the elevated Windows sandbox. Do not assume the test suite runs on either.

#### Read-only subagent fan-out

Every adapter can fan out from a read-only turn to child subagents. Probes on 2026-09-23 measured each installed CLI.

- `claude`: Plan mode delegates research to the built-in Explore and Plan subagents. They inherit the role model (Explore is capped at Opus on the Claude API). The adapter sets `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` on read-only turns only, so plan mode reads files directly. Worker turns stay unchanged. The variable disables only the built-in Explore and Plan subagents; the general-purpose and custom subagents stay available. Requires Claude Code v2.1.198 or later; older versions ignore the variable.
- `codex`: A read-only `exec` turn kept the collaboration tools. On codex-cli 0.156.1 the session rollout recorded a `spawn_agent` call and its subagent reply, while `--json` collapsed the spawn into a `collab_tool_call`. The `<multi_agent_role>` developer message and the `spawn_agent` tool description state that subagents inherit the parent model and reasoning effort. No switch disables it: `--disable multi_agent`, `--disable multi_agent_v2`, `-c features.multi_agent=false`, `-c agents.max_depth=0`, and `--ignore-user-config` each still spawned a subagent. A read-only codex turn can therefore cost the parent model a multiple of what the transcript suggests.
- `agy`: On Antigravity CLI 1.2.8, a plan-mode turn ran a `research` subagent through `invoke_subagent`, visible as a `step_type: "subagent"` step in `--output-format stream-json`. The binary defaults a subagent `model` to `inherit`, the parent model. No CLI flag or setting disables it.
- `opencode`: On OpenCode v0.0.0-dev-20030, a plan turn ran an `explore` subagent through the `subagent` tool, visible as a `tool_use` event in `run --format json`. The `explore` and `general` agents set no model, so they inherit the session model. The adapter sets `OPENCODE_CONFIG_CONTENT` with `subagent` and `edit` denies on read-only turns only; an A/B run through the adapter showed the `subagent` tool call without the deny and no such call with it. OpenCode merges that per-turn document after the user config, so the `edit` deny removes the edit and write tools even when a global permissions allow resolves after the plan agent's own `edit` deny (issue #107, probed on v0.0.0-dev-20033). The tools are absent entirely, so a read-only turn cannot save plan files under `~/.opencode/plan/*` either. Shell stays available for read-only commands such as `git diff`; the adapter does not deny `shell`, so a read-only turn can still write through shell. A user-set `OPENCODE_CONFIG_CONTENT` is replaced on read-only turns, so permission rules belong in `opencode.json`. Worker turns stay unchanged.
- `copilot`: On Copilot CLI 1.0.89-0, a read-only turn ran an `explore` subagent through `task` and a `search-subagent` through `search_code_subagent`, visible in `--output-format json`. The `subagent.started` event carried `modelSelectionSource: "agent_definition_default"`, and the subagent ran on `gpt-5.6-luna` while the parent ran on `gpt-5.4`. Copilot subagents do not inherit the role model, so a read-only turn does not multiply the role-model budget; the subagent still runs and still costs money on its own model. No switch is reliable: `--excluded-tools task` removed `task`, and the model then used `search_code_subagent`.

Per-model usage cannot separate parent tokens from subagent tokens on the same model (#47). Fan-out above rests on tool-call traces and the controlled A/B probe, not on token totals.

### Mutation detection

Before and after every read-only turn (reviewer and orchestrator), the runtime takes a snapshot of the Git work tree, index, and `HEAD`.
If any modified, added, or deleted tracked or untracked file, index change, or commit is detected, the run aborts immediately with a fatal `MutationError` (exit code 1).

**No-revert rule**: Detected modifications are left intact in the work tree so the user can inspect what the agent did.

Known limits:

- Ignored files (matching `.gitignore`) are not tracked.
- Mutations reverted within the same turn are not detected.
- A change anywhere in the repository that contains `--cwd` aborts a read-only turn, even outside `--cwd`.

## Transcript

When `--transcript <file>` is specified, a JSON transcript is written upon process exit (except when argv parsing fails).

The transcript records each validated orchestrator action, each child result, and one `invocation` event per CLI call, all with timestamps, plus the final exit code and error. It does not record raw orchestrator responses. Its `exitCode` is the process exit code, so a reader that treats `0` as success must also accept `4` for a recorded finish (#279).

A `refusal` event records a `finish` the runtime refused under `--require-accept` or `--require-ci`, and a `run_worker` action a `--mode review-only` run refused, with the `reason` string and the `stepsUsed` at the refusal. The event follows the refused `action` event, so a reader sees the refused action, then the refusal and its reason. A `--require-ci` refusal carries the gate reason, such as `the PR head differs from the reviewed commit`, or `the PR gate could not be evaluated: <error>` when the gate could not read GitHub at all. A run emits one `refusal` event per refusal. The run ends with exit 1 at a refusal that has no child turn since the last one, or at a refusal with no step budget left for the corrective turn.

In the headless loop, one refusal reports every condition the finish breaks. The interactive `role finish` reports every condition above the `--require-ci` gate, in this order: the `unresolvedCompare` marker, then the completion rule, then the declared-PR gate condition. It never lists a `--require-ci` condition beside those. The marker condition applies to a run that carries the gate and to a run that declared `--pr <pr>`, because both need the gate that resolves the compare. On that path the `--require-ci` gate runs only when nothing above it refused, so a refused `finish` never reaches the gate and never reads GitHub. A later interactive `finish` can therefore report a `--require-ci` condition that the first refusal did not name. The headless loop evaluates every gate it owns, as origin/main did, so the `--require-ci` gate runs whenever the run carries it and the declared-PR condition did not refuse, and a finish the marker, the `review-only` condition, or `--require-accept` already refused still runs the gate. Only the declared-PR gate condition skips it. Running the gate is not the same as reading GitHub: the gate checks two local conditions first, and only then reads, so it refuses with no GitHub call when the latest reviewer turn has no reviewed state and when the reviewed work tree is not clean, while every other condition it checks needs a read to settle it, the PR head comparison included, because it reads the PR first. The run ends when two refusals land with no child turn between them, or when the step budget is gone, so a prompt that named a single condition would spend its one corrective turn on a condition the next refusal named instead.

Two different things are cleared here, and the wording keeps them apart. Any child turn clears the prior-refusal flag, which is bookkeeping. Satisfying the refused condition is separate: the marker is satisfied by editing the finish action, so a finish refused for the marker alone needs no child turn and costs no step, while every other condition needs one. A gate refusal needs a reviewer turn, since the gate reads the reviewed state that only a reviewer turn establishes. A worker turn resets that state to none rather than establishing it, so on its own it satisfies neither the gate nor the completion rule, and a worker turn is needed first only when the condition is about the change rather than the checks. A finish refused because a required check is still pending therefore consumes a step for the reviewer turn that re-reads the state once the check reports, so leave `--max-steps` room for it.

A re-finish after a marker-only refusal is still a repeat in the bookkeeping sense: if anything else refuses it, the flag is still set and the run ends on exit 1. That is rare, and it is the price of not spending a step on a turn the marker did not need.

A `gh` failure inside the gate is a refusal, not a crash, so a transient credential or network failure is refused on the ordinary path with the work of that attempt intact, and the run ends on exit 1 when the failure recurs with no child turn in between. The orchestrator cannot reach a credential or a network itself, so the only retry it owns is a reviewer turn that re-runs the gate, and that costs a step like any other.

An `unresolved-compare` event records a `finish` whose action set `"unresolvedCompare": true`, the case where the parent records an unresolved PR-head compare under `notDone` and `open` instead of verifying it (#266). The event follows the finish `action` event and carries `stepsUsed`. The same finish exits `4` instead of `0` and keeps the same summary, so the recorded finish stays distinguishable without a transcript: a consumer that reads only the exit code sees `4` for a recorded unresolved compare and `0` for a verified finish (#279). A run without `--require-ci` has no PR input, so only the parent can report the condition, through that field, and a `finish` that records the compare and omits the field produces no event and exits `0` (issue #286). With `--require-ci <pr>` the runtime resolves the PR head itself, so the marker is refused rather than recorded and the omission leaves nothing to detect (#293). With `--pr <pr>` the run declares that PR, so the gate for that PR is required and the marker is refused with the missing gate (issue #302).

A `no-required-checks` event records a finish the `--require-ci` gate passed because every required-check source stated that the base branch has no required check, and the merge state was one the gate could read, so the gate verified the PR head, the clean reviewed tree, and the merge state, and no check status at all. It carries the gated `pr` and the `stepsUsed`, and is emitted on an accepted finish only, so a run on a branch that does require a check never carries it and a refused finish never reports an absence. Without the event a finish on such a branch reads exactly like one whose checks passed, which is the gap issue #336 closed (issue #336).

An `invocation` event exists for every CLI call: orchestrator attempts, orchestrator repair turns, and child turns, with `status` `ok` or `error`. When the adapter exposes usage, the event carries a `usage` object. The Claude and Copilot adapters map it from the CLI result:

- `models`: the per-model usage map keyed by model id. The Claude CLI exposes it; the Copilot CLI does not.
- `mainLoop`: the top-level `usage` field. Copilot exposes a session-cumulative `result.usage` object here, with no token counts and possible `codeChanges.filesModified` paths. Claude exposes its main-loop usage here.
- `totalCostUsd`: `total_cost_usd`. The CLI must expose it for this key to exist; Copilot does not.

Do not sum Copilot `mainLoop` values across invocation events. Its usage is cumulative for the session, not per turn.

The OpenCode adapter maps usage from the `opencode run --standalone --format json` stream. A step that ends with tool calls emits a `step_finish` part carrying `tokens` (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and `cost`; the adapter sums both across steps:

- `mainLoop`: the summed `tokens` object.
- `totalCostUsd`: the summed `cost`.

A failed turn keeps the usage its completed steps reported, the same as the Claude adapter. No event names the model, so `models` is omitted. Usage was inspected against OpenCode `v0.0.0-dev-19933`; in that version only steps that end with tool calls emit a `step_finish`, so a text-only turn, and the closing text step of a tool-using turn, contribute no usage.

The Antigravity adapter maps `mainLoop` from the CLI `usage` field. Antigravity reports no cost and no per-model breakdown.

The Codex adapter maps `turn.completed.usage` to `mainLoop`. The map contains input, cached input, cache-write input, output, and reasoning-output token counts. The token counts are cumulative for the thread, not per turn. Codex reports no cost or per-model usage.

Other adapters emit `invocation` events without `usage` until their CLI output is mapped. Per-model usage shows which models ran inside a turn. It cannot separate parent tokens from subagent tokens on the same model.

```json
{
  "task": "...",
  "cwd": "...",
  "options": { "maxSteps": 20, "timeout": 3600, "requireAccept": true },
  "roles": {
    "orchestrator": { "kind": "codex", "model": null, "effort": null, "sessionId": "..." },
    "worker": { "kind": "claude", "model": "...", "effort": "...", "sessionId": "..." },
    "reviewer": { "kind": "agy", "model": null, "effort": null, "sessionId": "..." }
  },
  "events": [
    { "type": "invocation", "at": "...", "stepsUsed": 0, "role": "orchestrator", "status": "ok", "usage": { ... } },
    { "type": "action", "at": "...", "stepsUsed": 0, "action": { ... } },
    { "type": "invocation", "at": "...", "stepsUsed": 1, "role": "worker", "status": "ok", "usage": { ... } },
    { "type": "result", "at": "...", "stepsUsed": 1, "role": "worker", "result": { ... } },
    { "type": "invocation", "at": "...", "stepsUsed": 1, "role": "orchestrator", "status": "ok", "usage": { ... } },
    { "type": "action", "at": "...", "stepsUsed": 1, "action": { "action": "finish", "summary": { ... } } },
    { "type": "refusal", "at": "...", "stepsUsed": 1, "reason": "no reviewer accept on the latest changed state after a worker turn" },
    { "type": "invocation", "at": "...", "stepsUsed": 2, "role": "reviewer", "status": "ok", "usage": { ... } },
    { "type": "result", "at": "...", "stepsUsed": 2, "role": "reviewer", "result": { ... } },
    { "type": "invocation", "at": "...", "stepsUsed": 2, "role": "orchestrator", "status": "ok", "usage": { ... } },
    { "type": "action", "at": "...", "stepsUsed": 2, "action": { "action": "finish", "summary": { ... } } }
  ],
  "exitCode": 0,
  "error": null
}
```

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Orchestrator returned `finish` with valid 5-part summary and no `unresolvedCompare` marker.                                                                                                                                                                                                                                                                                                                                                              |
| 1    | Orchestrator returned `abort`, a `--require-accept` or `--require-ci` finish refused twice or refused with no step budget left, a `--pr` declaration with no matching gate refused the finish, a `--mode review-only` run that refused a `run_worker` action, a usage error, orchestrator CLI failure or timeout, mutation detected, or controller error. A child timeout is not fatal: the orchestrator receives it as an error result and can recover. |
| 2    | Step limit reached (`--max-steps`) with work remaining.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4    | Orchestrator returned a `finish` that set `unresolvedCompare: true`. The run is a recorded finish, not a failure: the summary is printed as for exit 0 and the transcript holds no error. The code is what tells an exit-code-only consumer that the PR-head compare was never verified. A consumer that treats any nonzero code as failure must special-case 4, and so must a consumer that reads the transcript `exitCode`.                            |
| 130  | Interrupted by `Ctrl+C` (active children killed).                                                                                                                                                                                                                                                                                                                                                                                                        |

## Development

```bash
pnpm fmt         # Format files with oxfmt
pnpm fmt:check   # Check formatting
pnpm lint        # Lint files with oxlint
pnpm test        # Run Vitest test suite
```

## Releasing

The release workflow stages a version on a published GitHub release or a manual dispatch, authenticated by OIDC trusted publishing. No npm token is stored.

npm requires the package to exist before a trusted publisher can be configured, so the first version is published once from a checkout:

```bash
npm login
npm publish
```

Then add a trusted publisher on npmjs.com: package settings, **Trusted publishing**, **GitHub Actions**, organization or user `andromarces`, repository `agent-loops`, workflow filename `release.yml`, allowed actions `npm stage publish`.

For later releases, bump the version, then publish a GitHub release with tag `v<version>`. The tag must match the `package.json` version. The workflow runs `npm stage publish` and prints a stage id. Review and approve the staged version with 2FA:

```bash
npm stage list
npm stage view <stage-id>
npm stage approve <stage-id>
```

A manual dispatch must run on the release tag, for example `gh workflow run release.yml --ref v<version>`. A dispatch on a branch is rejected, because npm records provenance from the run ref, not the checked-out commit.

The version goes live only after approval. Staged publishing needs npm 11.15.0 or later and 2FA on the account.

## Manual smoke test

Run against real CLI agents in a temporary Git repository:

```bash
# Prepare scratch repo
mkdir /tmp/smoke-repo && cd /tmp/smoke-repo
git init
git commit --allow-empty -m "init"

# Run smoke test
agent-loop \
  --orchestrator codex \
  --worker claude \
  --reviewer agy \
  --max-steps 4 \
  --timeout 600 \
  --transcript ./run.json \
  --task "Add a README line that names the project."
```

## Future additions

Features considered for future development once the hybrid loop stabilizes:

- Orchestrator-addressable roles (allowing dynamic registration of additional named specialist roles)
- Per-role extra CLI arguments and flags
- GitHub pull request mode
- Configurable validation commands and automated gates
- Persistent headless-loop state and session resume across process restarts
- A streamed headless transcript
