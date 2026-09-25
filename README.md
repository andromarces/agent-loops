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

- **Orchestrator**: Evaluates task status, worker findings, or reviewer feedback, and returns a validated JSON action (`run_worker`, `run_reviewer`, `finish`, `abort`). It never edits files or executes subshells directly.
- **Worker**: Executes the task, modifies files, and runs validation commands in the target repository.
- **Reviewer**: Evaluates the repository state and tests in read-only mode.
- **Deterministic runtime**:
  - Enforces step limits (`--max-steps`, default 20) and timeout boundaries.
  - Spawns agents, manages persistent sessions, and captures process signals (`Ctrl+C` exits 130).
  - Enforces non-mutating safety on reviewer and orchestrator turns using CLI flags and pre/post Git work-tree mutation detection.
  - Recovers from malformed JSON via a single repair turn.
  - Records validated orchestrator actions, child results, one `invocation` event per CLI call with usage when the adapter exposes it, timestamps, exit code, and error when `--transcript` is provided. Raw orchestrator responses are not recorded.

See [Architecture Decision Records](adr/README.md) for background and architectural decisions ([ADR 0001](adr/0001-hybrid-orchestrator-runtime.md), [ADR 0002](adr/0002-harness-neutral-orchestrator-instructions.md)).

## Supported agents

The controller supports these CLI names:

- Claude Code: `claude`
- Codex CLI: `codex`
- Antigravity CLI: `agy` (alias: `antigravity`)
- OpenCode: `opencode` (OpenCode v2, npm `@opencode/cli`)
- GitHub Copilot CLI: `copilot`

Each adapter manages its own persistent session across turns. Model and effort arguments pass through to the CLI on every turn.

The OpenCode adapter passes `--standalone` on every turn. The turn runs against a private server instead of the shared background service, so the run does not depend on a background `opencode` service. Provider variables set on the shared service with `opencode service set env` do not apply to a standalone turn; provide them in the process environment. See [Background service](https://opencode.ai/v2/docs/cli#background-service) in the OpenCode CLI docs.

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

```bash
agent-loop install --harness claude,codex --yes
agent-loop uninstall
```

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
--max-steps <count>           Maximum child steps. Defaults to 20.
--timeout <seconds>           Timeout per agent invocation. Defaults to 3600. 0 disables the bound.
--transcript <file>           Record execution transcript to a JSON file.
--verbose                     Enable debug-level lifecycle logging, including snapshot activity.
-h, --help                    Show help.
```

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

Operations: `dispatch` (default), `finish`, `abort`.

- The run state lives at a fixed path derived from the resolved `--cwd` (`<os tmpdir>/agent-loops/runs/<sha256 of cwd, shortened>/state.json`, with `state.lock` beside it). There is no `--state` flag; `AGENT_LOOP_RUNS_ROOT` overrides the root for tests only.
- The init call requires `--parent-session`: the CLI refuses an init without it,
  and refuses an unexpanded placeholder such as `${CLAUDE_SESSION_ID}` or
  `%CODEX_THREAD_ID%`, before any state is written. A run through `role` is
  therefore always guarded; the headless `agent-loop` command is the explicit
  unguarded path.
- The init call writes a session index entry at `<root>/sessions/<parent-session>` pointing at the state file, so a parent guard hook (#57) can look the run up by session id even when `--cwd` is a different work tree. A later init call from the same session overwrites the entry.
- Prompts come from stdin by default, or `--prompt-file`. `finish` reads the five-key summary as JSON on stdin; `abort` takes `--reason`.
- The state file records `task`, `mode`, `cwd`, `parentSession`, `maxSteps`, `timeout`, `stepsUsed`, `lifecycle`, `roles.{worker,reviewer}.{kind,model,effort,sessionId}` (`roles.worker` is null in `review-only`), `lastDispatch`, and `lastResult`, plus `summary` or `reason` when terminal and `resumeDecision` when a maintainer resumed an interrupted run. Updates are atomic (temp file plus rename); exclusive access uses `state.lock` with a stale-lock check on the owner pid.
- Lifecycle values: `active`, `dispatched`, `interrupted`, `halted`, `finished`, `aborted` (terminal: `halted`, `finished`, `aborted`). A turn interrupted between the CLI start and the state write leaves `dispatched` with a dead lock owner; the first call after the crash marks it `interrupted`, exits non-zero, and never repeats the turn, even with `--resume-interrupted`. From `interrupted`, only `abort` or an explicit `dispatch --resume-interrupted` is accepted.
- The lock is fail-closed on ambiguity: a contender that finds a lock it cannot read (created moments ago, content not yet written) exits non-zero and never removes it; only an unparseable lock older than a grace window, or one whose recorded pid is dead, is treated as stale.
- The reviewer turn runs under the same `withMutationCheck` as the headless loop: a detected mutation or snapshot error is fatal, keeps the charged step, and sets `halted`. No further dispatch is possible; the next run needs a new init call, which archives the halted file as `state.<timestamp>.json`.
- `mode: review-only` rejects `--role worker` as a hard guard and does not require `--worker` at init. `finish` is completion of the requested work, not code acceptance: it is accepted from `active` in any mode, and the five-key summary carries the reviewer verdict and unresolved findings.
- The reviewer is required to end with one explicit `Verdict:` line (`accept` or `reject`, parsed case-insensitively) inside its closing block. The verdict word alone, the word closed by a sentence period (`reject.`), or the word followed by a separator and a trailing clause (`reject — the state does not pass`) parses to that word, unless the clause names either verdict as a whole word. Any other malformed value, including a missing line or a line that names both verdicts, yields `verdict: unknown`; process success never implies acceptance.
- `--transcript <file>` appends one JSON line per `invocation` and `result` event, in the same shape as the headless mode, accumulating across calls.

Stdout carries exactly one JSON envelope; all logs go to stderr:

```json
{
  "role": "reviewer",
  "status": "ok",
  "report": { "conclusion": "...", "why": "...", "blockers": "..." },
  "verdict": "accept"
}
```

`report` is parsed from the closing block every child turn must end with. When parsing fails, `report` is null and `raw` carries the tail of the response. `status: "error"` carries `error`, and every error path still prints one JSON object. The subcommand launches no orchestrator model and accepts no `--orchestrator` flags.

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
- The parent-edit guard (#57) reads `--parent-session` from the state index
  (see [Parent guard details](docs/parent-guard.md)). Every `role` init requires
  `--parent-session`; a legacy state written without one keeps its parent
  unguarded.

## Parent guard: hard read-only for the parent session

The parent rule ("the orchestrator never edits files") is prompt-only, so a drifting parent session can still edit. Five harnesses add a hard guard for the file-edit tools, and all share the decision logic in `src/hook/decision.mjs`. See [Parent guard details](docs/parent-guard.md) for the per-harness matchers, the session-field mapping, and the pre-tool hook availability survey.

## Reviewer safety

Reviewer and orchestrator turns run in read-only mode to prevent unintended repository mutations.

### Read-only CLI flags

| CLI        | Read-only invocation flag     | Flag effect                                                                                                                        | Role-model subagent fan-out                                              | Evidence                              |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `claude`   | `--permission-mode plan`      | Plan mode blocks file edits.                                                                                                       | Yes; Explore and Plan subagents run on the role model. Adapter disables. | Claude docs; issue #46 smoke test     |
| `codex`    | `-c sandbox_mode="read-only"` | Passes read-only sandbox mode on new and resumed sessions.                                                                         | Yes; `spawn_agent` subagents inherit the parent model and effort.        | Codex rollout transcript              |
| `agy`      | `--mode plan`                 | Plan mode disables file edits.                                                                                                     | Yes; `invoke_subagent` subagents inherit the parent model by default.    | CLI `stream-json` step                |
| `opencode` | `--agent plan`                | The plan agent blocks edits; a global permissions allow can cancel it. Adapter denies `edit` per turn. Shell writes stay possible. | Yes; the `subagent` tool inherits the session model. Adapter denies it.  | `run --format json` tool call; A/B    |
| `copilot`  | `--deny-tool write`           | Denies write/edit tools. External permissions may still permit shell writes.                                                       | No; subagents run on an agent-definition default model.                  | `--output-format json` subagent event |

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

The transcript records each validated orchestrator action, each child result, and one `invocation` event per CLI call, all with timestamps, plus the final exit code and error. It does not record raw orchestrator responses.

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
  "options": { "maxSteps": 20, "timeout": 3600 },
  "roles": {
    "orchestrator": { "kind": "codex", "model": null, "effort": null, "sessionId": "..." },
    "worker": { "kind": "claude", "model": "...", "effort": "...", "sessionId": "..." },
    "reviewer": { "kind": "agy", "model": null, "effort": null, "sessionId": "..." }
  },
  "events": [
    { "type": "invocation", "at": "...", "stepsUsed": 0, "role": "orchestrator", "status": "ok", "usage": { ... } },
    { "type": "action", "at": "...", "stepsUsed": 0, "action": { ... } },
    { "type": "invocation", "at": "...", "stepsUsed": 1, "role": "worker", "status": "ok", "usage": { ... } },
    { "type": "result", "at": "...", "stepsUsed": 1, "role": "worker", "result": { ... } }
  ],
  "exitCode": 0,
  "error": null
}
```

## Exit codes

| Code | Meaning                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Orchestrator returned `finish` with valid 5-part summary.                                                                                                                                                  |
| 1    | Orchestrator returned `abort`, orchestrator CLI failure or timeout, mutation detected, or controller error. A child timeout is not fatal: the orchestrator receives it as an error result and can recover. |
| 2    | Step limit reached (`--max-steps`) with work remaining.                                                                                                                                                    |
| 130  | Interrupted by `Ctrl+C` (active children killed).                                                                                                                                                          |

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
