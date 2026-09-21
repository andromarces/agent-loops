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

With `opencode` and neither `--<role>-model` nor `--<role>-effort`, the adapter runs model `opencode-go/deepseek-v4.1-flash` at effort `high`. An explicit `--<role>-model` passes through unchanged, with no variant appended; `--<role>-effort` alone applies that effort to the default model and reaches the CLI as `opencode-go/deepseek-v4.1-flash#<effort>`.

That model is on the paid OpenCode Go provider, so the default needs an OpenCode Go subscription. A caller without it must pass `--<role>-model`.

`--<role>-model` and `--<role>-effort` record what the caller requested, not the effective model. The adapter resolves the default per turn and logs the effective `model#effort` it passes. When the defaulted turn fails, the error names the default model and points at `--<role>-model`. An effort the default model rejects makes opencode fail loudly rather than fall back.

## Requirements

- Node.js 22 or later
- pnpm
- Git (the target `--cwd` must be inside a Git work tree)
- Installed and authenticated CLI agents

## Install

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd agent-loops
pnpm install
```

Then make `agent-loop` resolvable. Add the pnpm global bin directory to PATH, then register the `bin` field globally from the repository root:

```bash
pnpm setup   # restart the shell afterwards
pnpm add -g .
```

pnpm v11 removed `pnpm link --global` and keeps global bins under `PNPM_HOME`; `pnpm add -g .` fails with `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH` until `pnpm setup` puts that directory on PATH. Without a global install, call the CLI entry directly and quote the repository path so a path with spaces works, or use the package script from the repository root:

```bash
node "<repo>/src/cli.mjs" role ...
pnpm agent-loop role ...
```

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

| Harness                  | Entry point                          | Invocation                                     |
| ------------------------ | ------------------------------------ | ---------------------------------------------- |
| Claude Code              | `.claude/skills/agent-loop/SKILL.md` | `/agent-loop <task and role settings>`         |
| OpenCode                 | `.opencode/plugins/parent-guard.ts`  | `/agent-loop <task and role settings>`         |
| Codex CLI                | `.codex/prompts/agent-loop.md`       | `/prompts:agent-loop <task and role settings>` |
| Copilot CLI, Antigravity | universal fallback (below)           | first prompt references the file               |

- The Claude Code skill sets `disable-model-invocation: true`, so only the
  maintainer activates it with `/agent-loop`, and it omits `context: fork`, so
  the skill runs in the current session. Its body passes `${CLAUDE_SESSION_ID}`
  as `--parent-session` on the init dispatch call.
- The OpenCode entry point is a local plugin (`.opencode/plugins/parent-guard.ts`),
  loaded automatically from `.opencode/plugins/`. Stored command templates expose
  no session id, so the plugin registers the `/agent-loop` command itself: its
  executor reads `CommandInvocation.sessionID` and carries that id into the
  orchestrator prompt, and the init dispatch call passes it as
  `--parent-session`.
- The Codex CLI prompt (`.codex/prompts/agent-loop.md`) passes the active shell's
  `CODEX_THREAD_ID` value as `--parent-session`. This environment variable is an
  undocumented dependency and can change on upgrade. It fails open: when it is
  absent, do not start a guarded run. Run `/hooks` once to review and trust the
  repository hook. Do not use `--dangerously-bypass-hook-trust` for normal use.
- Universal fallback (Copilot CLI, Antigravity): reference
  `docs/orchestrator-instructions.md` in the first prompt and follow it. A
  native entry point is added only after that harness documents a custom-prompt
  mechanism.
- The parent-edit guard (#57) reads `--parent-session` from the state index
  (see Parent guard below). For any run without `--parent-session`, the parent
  stays unguarded.

## Parent guard: hard read-only for the parent session

The parent rule ("the orchestrator never edits files") is prompt-only, so a drifting parent session can still edit. Three harnesses add a hard guard for the file-edit tools: Claude Code through a `PreToolUse` hook in `.claude/settings.json`, Codex CLI through a `PreToolUse` hook in `.codex/hooks.json`, and OpenCode through a `permission` `evaluate` plugin hook. All share the decision logic in `src/hook/decision.mjs`, so they deny and release under the same rule.

- Matchers: Claude Code uses `Edit|Write|MultiEdit|NotebookEdit`. Codex CLI uses
  `apply_patch`, which its hook input reports as `tool_name: "apply_patch"`.
  `Bash` stays allowed because the parent needs it to run `agent-loop role`; a
  shell-based edit bypasses both guards. Full enforcement needs a harness that
  exposes only orchestration tools.
- The hook (`src/hook/parent-guard.mjs`) reads the hook input on stdin and uses only `session_id`. It resolves the state file through the session index written by the init call, never through the hook `cwd`, so a parent whose run targets a different `--cwd` stays guarded wherever it edits. No environment variable is required at parent start-up; the harness entry points (#56) pass their session id as `--parent-session` on init.
- Deny only when the hook `session_id` equals `parentSession` in the registered state and the lifecycle is non-terminal (`active`, `dispatched`, `interrupted`). The guard releases only on `finish`, `abort`, or a `halted` state; during `interrupted` it stays engaged, and `dispatch --resume-interrupted` keeps it engaged because the resumed run is non-terminal again.
- Everything else allows: a worker dispatched by `role` in the same cwd (a different session id), a second interactive session in the same cwd, a state without `parentSession`, and a missing or corrupt index entry or state file. The guard fails open by design: it supplements the prompt-only rule, so an unknown record never blocks a tool call.
- Without a state file the hook does one absent-file read, prints nothing, and exits 0; the normal permission flow applies. The deny reason names orchestrator mode and points at `role dispatch` / `finish` / `abort`.
- The hook is registered as an exec-form command (`node` + script `args`), which spawns `node` directly on every platform Claude Code supports, with no shell.
- On OpenCode, `.opencode/plugins/parent-guard.ts` registers a `permission` `evaluate` hook. It reads `PermissionEvaluation.sessionID`, resolves the state through the same session index, and sets `effect: "deny"` with the same reason under the same rule. A live probe showed the `edit` action covers the `edit` and `write` tools; whether `patch` maps to `edit` is unverified, so a `patch`-only edit is a known gap. `shell` stays allowed, as `Bash` does on Claude Code. The guard exists only while the plugin is loaded, so a session that disables it stays unguarded.
- The plugin runs inside the OpenCode server process, so it resolves `AGENT_LOOP_RUNS_ROOT` from that process's environment; the Claude Code hook inherits the parent shell's environment instead. The override is test-only, but using it outside tests would point the plugin and the `agent-loop` CLI at different roots and disable the guard silently.

### Pre-tool hook availability by harness

Surveyed 2026-09-20 against current vendor docs. A session-keyed guard needs both a pre-tool hook and a documented way for the parent to learn its own session id at init time; the guard ships only where both exist.

| Harness            | Pre-tool hook                                                                                                                                                | Guard                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Claude Code        | `PreToolUse`, deny supported, `session_id` in input                                                                                                          | Implemented (this repo)   |
| Codex CLI          | `PreToolUse`, deny supported, `session_id` in input; entry point depends on undocumented `CODEX_THREAD_ID`                                                   | Implemented (best effort) |
| Antigravity CLI    | `PreToolUse` hooks (workspace or global `hooks.json`), `conversationId` in input                                                                             | Not implemented           |
| GitHub Copilot CLI | `preToolUse` since v0.0.396, deny supported, `session_id` in input; repo-level `.github/hooks/` loading reported broken in the CLI (github/copilot-cli#1730) | Not implemented           |
| OpenCode           | `permission` `evaluate` plugin hook can set `deny`; event carries `PermissionEvaluation.sessionID`                                                           | Implemented (this repo)   |

Codex CLI now uses its `PreToolUse` hook with the session id in hook input. Its
entry point relies on `CODEX_THREAD_ID` from the shell environment, which is not
documented and can break on upgrade. The guard fails open when the variable is
absent or unusable. Antigravity and Copilot still lack a documented parent-session
channel. OpenCode has both: a command reads `CommandInvocation.sessionID`, and
the permission hook reads `PermissionEvaluation.sessionID`.

## Reviewer safety

Reviewer and orchestrator turns run in read-only mode to prevent unintended repository mutations.

### Read-only CLI flags

| CLI        | Read-only invocation flag     | Note                                                                         |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `claude`   | `--permission-mode plan`      | Plan mode blocks file edits. See the note on research subagents below.       |
| `codex`    | `-c sandbox_mode="read-only"` | Passes read-only sandbox mode on new and resumed sessions.                   |
| `agy`      | `--mode plan`                 | Plan mode disables file edits.                                               |
| `opencode` | `--agent plan`                | Plan agent rejects edit tools.                                               |
| `copilot`  | `--deny-tool write`           | Denies write/edit tools. External permissions may still permit shell writes. |

#### Claude plan-mode research subagents

Plan mode delegates research to the built-in Explore and Plan subagents. They inherit the role model (Explore is capped at Opus on the Claude API), so a read-only Claude turn spawns hidden subagents at the cost of `--orchestrator-model` or `--reviewer-model`.

The Claude adapter sets `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` on read-only turns only. Plan mode then reads files directly. Worker turns are unchanged. The variable disables only the built-in Explore and Plan subagents; the general-purpose subagent and custom subagents stay available. Requires Claude Code v2.1.198 or later; older versions ignore the variable.

### Mutation detection

Before and after every read-only turn (reviewer and orchestrator), the runtime takes a snapshot of the Git work tree, index, and `HEAD`.
If any modified, added, or deleted tracked or untracked file, index change, or commit is detected, the run aborts immediately with a fatal `MutationError` (exit code 1).

**No-revert rule**: Detected modifications are left intact in the work tree so the user can inspect what the agent did.

Known limits:

- Ignored files (matching `.gitignore`) are not tracked.
- Mutations reverted within the same turn are not detected.
- Only paths within `--cwd` are monitored.

## Transcript

When `--transcript <file>` is specified, a JSON transcript is written upon process exit (except when argv parsing fails).

The transcript records each validated orchestrator action, each child result, and one `invocation` event per CLI call, all with timestamps, plus the final exit code and error. It does not record raw orchestrator responses.

An `invocation` event exists for every CLI call: orchestrator attempts, orchestrator repair turns, and child turns, with `status` `ok` or `error`. When the adapter exposes usage, the event carries a `usage` object. The Claude adapter maps it from the CLI result:

- `models`: the `modelUsage` map, keyed by model id. Includes subagent requests. Use it for model routing and cost attribution.
- `mainLoop`: the top-level `usage` field. Excludes subagents.
- `totalCostUsd`: `total_cost_usd`. Includes subagents.

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
- Persistent controller state and session resume across process restarts
- Streaming transcript logs and usage metadata
