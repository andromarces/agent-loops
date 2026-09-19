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
  - Records validated orchestrator actions, child results, timestamps, exit code, and error when `--transcript` is provided. Raw orchestrator responses and repair turns are not recorded.

See [Architecture Decision Records](adr/README.md) for background and architectural decisions ([ADR 0001](adr/0001-hybrid-orchestrator-runtime.md)).

## Supported agents

The controller supports these CLI names:

- Claude Code: `claude`
- Codex CLI: `codex`
- Antigravity CLI: `agy` (alias: `antigravity`)
- OpenCode: `opencode`
- GitHub Copilot CLI: `copilot`

Each adapter manages its own persistent session across turns. Model and effort arguments pass through to the CLI on every turn.

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
--timeout <seconds>           Timeout in seconds per invocation. Optional.
--transcript <file>           Record execution transcript to a JSON file.
-h, --help                    Show help.
```

## Reviewer safety

Reviewer and orchestrator turns run in read-only mode to prevent unintended repository mutations.

### Read-only CLI flags

| CLI        | Read-only invocation flag     | Note                                                                         |
| ---------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `claude`   | `--permission-mode plan`      | Plan mode blocks file edits.                                                 |
| `codex`    | `-c sandbox_mode="read-only"` | Passes read-only sandbox mode on new and resumed sessions.                   |
| `agy`      | `--mode plan`                 | Plan mode disables file edits.                                               |
| `opencode` | `--agent plan`                | Plan agent rejects edit tools.                                               |
| `copilot`  | `--deny-tool write`           | Denies write/edit tools. External permissions may still permit shell writes. |

### Mutation detection

Before and after every read-only turn (reviewer and orchestrator), the runtime takes a snapshot of the Git work tree, index, and `HEAD`.
If any modified, added, or deleted tracked or untracked file, index change, or commit is detected, the run aborts immediately with a fatal `MutationError` (exit code 1).

**No-revert rule**: Detected modifications are left intact in the work tree so the user can inspect what the agent did.

Known limits:

- Ignored files (matching `.gitignore`) are not tracked.
- Mutations reverted within the same turn are not detected.
- Only paths within `--cwd` are monitored.

## Transcript

When `--transcript <file>` is specified, a JSON transcript is written upon process exit (except when argv parsing fails):

The transcript records each validated orchestrator action and each child result with timestamps, plus the final exit code and error. It does not record raw orchestrator responses or repair turns.

```json
{
  "task": "...",
  "cwd": "...",
  "options": { "maxSteps": 20, "timeout": null },
  "roles": {
    "orchestrator": { "kind": "codex", "model": null, "effort": null, "sessionId": "..." },
    "worker": { "kind": "claude", "model": "...", "effort": "...", "sessionId": "..." },
    "reviewer": { "kind": "agy", "model": null, "effort": null, "sessionId": "..." }
  },
  "events": [
    { "type": "action", "at": "...", "stepsUsed": 0, "action": { ... } },
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
