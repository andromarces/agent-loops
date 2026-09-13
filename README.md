# Agent Loops

Run a task loop across several CLI coding agents.

A loop is an ordered list of roles. Each role binds to a CLI agent and keeps its own persistent session. The controller passes each role output to the next role, cycles through the list, and stops when the gate role reports completion or the iteration limit is reached.

Review is one preset, not the only purpose. Any repeating task fits: implement and verify, plan and build, draft and critique, migrate and test.

## Why

A common manual workflow looks like this:

```text
Agent A
   |
   | output
   v
Agent B
   |
   | output
   v
Agent C
   |
   | output
   v
Agent A
   |
  ...
```

Without automation, this requires repeated copy-paste between terminal sessions.

This project replaces the copy-paste role with a small controller. Each agent stays a separate persistent CLI session.

## Goals

- Keep the controller small.
- Use the existing CLI setup of the user.
- Keep every role session separate.
- Support any role count, from one to many.
- Support different CLI agents through adapters.
- Run on Windows, macOS, and Linux.
- Use the repository as the source of truth.
- Stop automatically when the gate role reports completion.
- Allow manual interruption with `Ctrl+C`.

## Current state

`src/cli.mjs` implements a two-role review loop with inline adapters. The multi-role controller described below is not built yet.

The repository tooling is in place: pnpm, husky, lint-staged, oxfmt, and oxlint.

## Concepts

- **Role**: a named position in the loop, for example `reviewer`, `worker`, `auditor`.
- **Agent**: the CLI that runs a role, for example `codex`.
- **Session**: the persistent CLI conversation of one role. Two roles on the same CLI keep separate session IDs.
- **Iteration**: one pass through every role, in declaration order.
- **Gate**: the role whose completion marker stops the loop. Defaults to the first role.
- **Prompt**: the instruction text for a role. A preset or a file supplies it.

## Supported agents

The controller supports these CLI names:

- Claude Code: `claude`
- Codex CLI: `codex`
- Antigravity CLI: `agy`
- OpenCode: `opencode`
- GitHub Copilot CLI: `copilot`

Each adapter starts or resumes the persistent session of its CLI.

The controller does not replace the configuration system of each CLI. Run the controller from the target project so each agent can load its existing project and user configuration.

Examples include:

- project instructions
- user instructions
- MCP configuration
- skills
- hooks
- provider authentication
- permissions

Exact behavior depends on the CLI.

## Requirements

- Node.js 22 or later
- pnpm
- At least one supported CLI agent
- Existing authentication for each selected CLI

## Install

Clone the repository:

```bash
git clone <repository-url>
cd agent-loops
```

Install dependencies:

```bash
pnpm install
```

The `prepare` script installs the Git hooks during that command.

## Development

Tooling:

- `pnpm` manages dependencies. `pnpm-workspace.yaml` sets `virtualStoreType: global`, so one virtual store serves every project on the machine.
- `husky` manages the Git hooks in `.husky/`.
- `lint-staged` runs `oxfmt` on the staged JS/TS code files in the `pre-commit` hook.
- `oxlint` runs in the `pre-push` hook over the JS/TS code files that the pushed commit range changes.

Scripts:

```bash
pnpm fmt         # Format the repository.
pnpm fmt:check   # Report unformatted files.
pnpm lint        # Lint the repository.
pnpm test        # Run the Vitest suite once.
pnpm test:watch  # Run Vitest in watch mode.
```

Hook behavior:

- `pre-commit` formats the staged JS/TS code files and restages them.
- `pre-push` lints only the JS/TS code files that changed in the pushed range. A new branch without a remote counterpart compares against `origin/HEAD`. A repository without that reference falls back to every tracked JS/TS code file.
- Neither hook touches Markdown, YAML, TOML, or lockfiles.
- Do not pass `--no-verify` to `git commit` or `git push`.

## Usage

The current CLI runs a fixed worker-first loop: a worker implements, then a reviewer verifies. Run it from the repository that the loop works on:

```bash
node /path/to/agent-loops/src/cli.mjs \
  --reviewer codex \
  --worker claude \
  --task "Implement the change."
```

PowerShell:

```powershell
node C:\path\to\agent-loops\src\cli.mjs --reviewer codex --worker claude --task "Implement the change."
```

From inside this repository, `pnpm agent-loop` runs the same script. After installation, the package binary runs it too:

```bash
agent-loop \
  --reviewer codex \
  --worker claude \
  --task "Implement the change."
```

Current options:

```text
--reviewer <agent>       Agent that reviews the repository. Required.
--worker <agent>         Agent that implements the task. Required.
--cwd <directory>        Working directory for the agents. Defaults to the directory where the command ran. Changes the working directory only; does not activate that directory's environment.
--task <text>            Worker task. Required.
--max-reviews <count>    Maximum review passes. Defaults to 10.
-h, --help               Show help.
```

Agent names: `claude`, `codex`, `agy` (alias `antigravity`), `opencode`, `copilot`.

### Environment and working directory

The loop spawns each agent CLI directly, without a shell. Agents inherit the environment of the process that launched the loop. Start the loop from a shell where direnv or a similar tool already exported the required variables. `--cwd` defaults to the directory where the command ran. `--cwd` changes the working directory of the agents; it does not activate that directory's environment. No default shell and no automatic environment loader are provided by design.

The worker acts first from `--task`. The reviewer verifies each worker result. The reviewer stops the loop only when its whole response is exactly `REVIEW_COMPLETE`. That completion message goes to the same worker session, which returns a final summary report with Changed, Verified, Deferred, Not done, and Open sections. The CLI prints the report and exits 0 without another reviewer turn. The loop exits with code 2 when the review limit is reached with findings remaining.

The sections from Examples onward describe the planned multi-role controller. Those flags do not exist in the current CLI.

## Examples

These examples use the planned multi-role interface.

Two roles, Codex reviews Claude Code:

```bash
agent-loop \
  --role reviewer=codex \
  --role worker=claude
```

Three roles, a planner feeds a builder, then an independent auditor gates the loop:

```bash
agent-loop \
  --role planner=claude \
  --role builder=codex \
  --role auditor=agy \
  --gate auditor \
  --task "Add rate limiting to the public API."
```

Four roles, two reviewers with different strengths:

```bash
agent-loop \
  --role security=codex \
  --role performance=copilot \
  --role worker=claude \
  --role verifier=opencode \
  --gate verifier
```

One role, a self-check loop:

```bash
agent-loop \
  --role worker=codex \
  --task "Fix the failing tests until the suite passes."
```

One CLI for every role:

```bash
agent-loop \
  --role reviewer=codex \
  --role worker=codex
```

The controller keeps one session ID per role, even when several roles use the same CLI.

## Options

Planned options for the multi-role controller:

```text
--role <name>=<agent>      Add a role. Repeat to build the loop. Order sets execution order.
--gate <name>              Role that can stop the loop. Defaults to the first role.
--prompt <name>=<file>     Prompt file for a role. Defaults to the preset for that role name.
--preset <name>            Load a bundled loop definition, for example "review".
--cwd <directory>          Working directory. Defaults to the current directory.
--task <text>              Task description passed to the first iteration.
--max-iterations <count>   Maximum loop passes. Defaults to 10.
-h, --help                 Show help.
```

## Completion contract

The current CLI uses the marker `REVIEW_COMPLETE`. The planned controller uses `LOOP_COMPLETE` as described below.

Every role prompt states the completion rule.

The gate role must end its response with this exact line when no actionable work remains:

```text
LOOP_COMPLETE
```

The controller stops when that marker appears as the final non-empty line of the gate role response.

A non-gate role that emits the marker does not stop the loop.

If the marker is absent, the controller passes the response to the next role.

## Loop

```text
1. Start the session of every role.
2. Send the task to the first role.
3. For each remaining role in order:
     a. Send the previous role output plus the role prompt.
     b. Record the response.
4. If the gate role response ends with LOOP_COMPLETE, stop.
5. If the iteration limit is reached, stop with exit code 2.
6. Start the next iteration at the first role. Resume every session.
```

Each role receives the previous role output as context only.

A role that verifies work must inspect the repository again. A report from another role is not proof that the work is correct.

## Presets

A preset is a named loop definition. It sets roles, prompts, and the gate.

The `review` preset defines:

- `reviewer`: inspect the repository, report actionable findings, do not modify files.
- `worker`: address the findings, run checks, report the result.
- gate: `reviewer`.

```bash
agent-loop --preset review --role reviewer=codex --role worker=claude
```

A `--role` flag binds an agent to a preset role. A `--prompt` flag overrides preset text.

## Safety

The controller does not enable unrestricted tool access by default.

It does not automatically add flags such as:

```text
--yolo
--allow-all-tools
```

Use the existing permission configuration of each CLI.

A headless agent can fail if it reaches an operation that requires an interactive approval prompt.

For unattended use, configure only the permissions that the repository and the selected workflow require.

## Exit behavior

The controller exits with:

```text
0  Loop completed. The gate role reported completion.
1  Controller or CLI execution failed.
2  Maximum iteration count reached while work remained.
```

`Ctrl+C` stops the loop immediately.

## Recommended repository structure

```text
agent-loops/
├─ README.md
├─ LICENSE
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ .oxfmtrc.json
├─ .gitignore
├─ .husky/
│  ├─ pre-commit
│  └─ pre-push
├─ src/
│  ├─ cli.mjs
│  ├─ controller.mjs
│  ├─ prompts.mjs
│  ├─ presets/
│  │  └─ review.mjs
│  ├─ agents/
│  │  ├─ index.mjs
│  │  ├─ claude.mjs
│  │  ├─ codex.mjs
│  │  ├─ agy.mjs
│  │  ├─ opencode.mjs
│  │  └─ copilot.mjs
│  └─ lib/
│     ├─ exec.mjs
│     └─ json.mjs
├─ test/
│  ├─ controller.test.mjs
│  ├─ prompts.test.mjs
│  └─ agents/
│     ├─ claude.test.mjs
│     ├─ codex.test.mjs
│     └─ ...
└─ examples/
   └─ basic.md
```

## File responsibilities

### `src/cli.mjs`

Parse command-line arguments.

Validate role names, agent names, and options.

Build the ordered role list and the gate selection.

Call the controller.

### `src/controller.mjs`

Own the loop.

Run every role in order.

Keep one session per role.

Enforce the iteration limit.

Stop on the completion marker from the gate role.

Return a stable exit result.

### `src/prompts.mjs`

Keep the prompt text in one place.

Export:

```js
rolePrompt(role, context);
loopComplete(text);
```

### `src/presets/`

Keep one file per bundled loop definition.

A preset exports role names, prompts, and the gate role.

### `src/agents/`

Keep one adapter per CLI.

Each adapter exposes the same interface:

```js
{
  (name, run(state, prompt, cwd));
}
```

The adapter owns CLI-specific details such as:

- command name
- command arguments
- session creation
- session resume
- JSON parsing
- response extraction

### `src/agents/index.mjs`

Map agent names to adapters.

Example:

```js
export const agents = {
  claude,
  codex,
  agy,
  antigravity: agy,
  opencode,
  copilot,
};
```

### `src/lib/exec.mjs`

Wrap process execution.

Keep `execa` configuration in one place.

Normalize:

- stdout
- stderr
- exit codes
- process errors

### `src/lib/json.mjs`

Contain shared JSON and JSON Lines parsing helpers.

## Adapter contract

Keep the controller independent from CLI-specific behavior.

Example:

```js
export async function run(state, prompt, cwd) {
  // Start or resume the CLI session.
  // Update state.sessionId.
  // Return the final response text.
}
```

State stays small:

```js
{
  role: "reviewer",
  kind: "codex",
  sessionId: null
}
```

Do not put loop behavior inside adapters.

## Package binary

`package.json` exposes the controller as a binary:

```json
"bin": {
  "agent-loop": "./src/cli.mjs"
}
```

`src/cli.mjs` starts with this line:

```js
#!/usr/bin/env node
```

After installation, the package exposes:

```bash
agent-loop --reviewer codex --worker claude
```

## Testing strategy

Do not call real external agents in normal unit tests.

Mock each adapter and test the controller state transitions.

Test at least these cases:

1. The gate role reports completion on the first pass.
2. Two roles run, then the gate role reports completion.
3. Three or more roles run in declaration order.
4. Several iterations occur.
5. The iteration limit is reached.
6. A non-gate role emits the marker and the loop continues.
7. A role CLI fails.
8. A role returns malformed structured output.
9. Several roles use the same CLI with different session IDs.
10. A single-role loop runs and stops.

Keep real CLI tests separate as optional integration tests.

## Future additions

Add features only when the basic loop is stable.

Useful additions include:

- transcript files
- persistent controller state
- loop resume after controller restart
- per-role model arguments
- per-role extra CLI arguments
- conditional role skipping
- parallel roles inside one iteration
- configurable completion marker
- user-defined preset files
- JSON run summary
- elapsed time and usage metadata
- Git branch or worktree checks
- GitHub pull request mode
- configurable validation commands
- dry-run mode

Avoid adding a database, daemon, message queue, web UI, or agent framework until a concrete requirement needs one.

## Design principle

The controller coordinates agents.

The agents inspect and modify the repository.

The repository remains the source of truth.
