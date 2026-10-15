# Agent Loops

Run one coding task as a loop of CLI coding agents.

- An **orchestrator** agent picks the next step.
- A **worker** agent changes the code and runs the tests.
- A **reviewer** agent checks the result. It must not change a tracked file, an unignored untracked file (a cache included), or Git state; writes only to ignored paths or temporary files outside the repository are allowed. Every CLI except Codex runs the reviewer with a read-only flag whose effect differs by CLI ([reviewer safety](docs/reference/reviewer-safety.md)), and a Codex reviewer runs with no sandbox by default, so only the mutation check detects an edit.
- A Node.js runtime enforces the step budget and the timeouts, and detects a change to the work tree during a reviewer or orchestrator turn.

```text
orchestrator ──> runtime ──> worker   (edits, tests)
                        └──> reviewer (no tracked change)
```

Supported agent CLIs: `claude`, `codex`, `agy`, `opencode`, `copilot`.

## Requirements

- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`
- Git
- At least one agent CLI from the list above, installed and signed in

## Install

```bash
npm install -g @andromarces/agent-loops
agent-loop install
```

`agent-loop install` adds an `/agent-loop` entry point and a parent guard to each
agent CLI that it finds. It asks which ones to set up.

- Pick harnesses with no prompt: `agent-loop install --harness claude,codex --yes`
- Preview the writes: `agent-loop install --dry-run`

pnpm works too: `pnpm add -g @andromarces/agent-loops`.

## Quick start

### Option 1: one command (headless)

```bash
agent-loop --orchestrator codex --worker claude --reviewer agy --task "Implement the change."
```

Run it inside the Git work tree of the target project, or pass `--cwd <dir>`.

### Option 2: from an agent session

Start the loop from the agent CLI that you already use:

| Agent CLI       | Type this                             |
| --------------- | ------------------------------------- |
| Claude Code     | `/agent-loop <task and roles>`        |
| Codex CLI       | `$agent-loop <task and roles>`        |
| OpenCode        | `/agent-loop <task and roles>`        |
| Antigravity CLI | `/agent-loop <task and roles>`        |
| Copilot CLI     | `agent-loop-copilot <task and roles>` |

`agent-loop-copilot` runs in a terminal and opens a Copilot session.

Your session becomes the orchestrator. The parent guard keeps it from editing
files.

## Common options

| Option                   | Use                                                 |
| ------------------------ | --------------------------------------------------- |
| `--cwd <dir>`            | Run in another Git work tree.                       |
| `--max-steps <n>`        | Limit the child turns. Default: 20.                 |
| `--timeout <seconds>`    | Limit one agent call. Default: 3600.                |
| `--transcript <file>`    | Save a JSON record of the run.                      |
| `--continue-from <file>` | Continue a run that hit the step limit.             |
| `--require-accept`       | Finish only after a reviewer accepts the work.      |
| `--test-cmd <command>`   | Run a test command before each reviewer turn.       |
| `--worker-model <model>` | Pick a model. Each role has `-model` and `-effort`. |

See all options: `agent-loop --help`.

## Exit codes

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Finished.                                            |
| 1    | Aborted, refused, or failed.                         |
| 2    | Step limit reached. Continue with `--continue-from`. |
| 4    | Finished, but the PR-head compare was not verified.  |
| 130  | Stopped with `Ctrl+C`.                               |

## Upgrade

```bash
npm install -g @andromarces/agent-loops@latest
agent-loop install --harness <list> --yes
```

Run the second command after every upgrade. It changes nothing when nothing changed.

## Uninstall

```bash
agent-loop uninstall
npm uninstall -g @andromarces/agent-loops
```

Run `agent-loop uninstall` first. It removes only what `install` wrote, and keeps a
file that you edited after install.

## More

- [Full reference](docs/reference.md): every option, safety rule, and verified
  behavior.
- [Develop from a clone](docs/reference/install.md#from-a-clone-development)
- [Architecture Decision Records](https://github.com/andromarces/agent-loops/blob/main/adr/README.md)

## License

[MIT](LICENSE)
