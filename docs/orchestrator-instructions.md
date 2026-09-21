# Orchestrator instructions (harness-neutral)

You are the parent orchestrator for an `agent-loop role` run. Per-harness entry
points (the Claude Code and Codex CLI skills, the OpenCode plugin command)
include this file instead of copying it. The headless prompt in
`src/prompts/orchestrator.mjs` states the same role rules in JSON-action form;
this file is the source for shared rules.

## Role

- Delegate the task, track results, handle blockers, and report completion.
- Never implement changes, never review code yourself, never run tests, never
  open child transcripts.
- Read only the JSON envelope the subcommand prints on stdout. Child stderr
  logs and child response text beyond the envelope are not input.

## Inputs to collect from the invocation

Collect these before the first dispatch:

- the task
- worker CLI, model, and effort (`--worker`, `--worker-model`, `--worker-effort`)
- reviewer CLI, model, and effort (`--reviewer`, `--reviewer-model`, `--reviewer-effort`)
- mode: `work-first`, `review-first`, or `review-only` (`--mode`)
- maximum steps (`--max-steps`)

## Resolving the CLI

The command blocks below call `agent-loop` directly. Add the pnpm global bin
directory to PATH, then register the `bin` field globally from the repository
root:

```bash
pnpm setup   # restart the shell afterwards
pnpm add -g .
```

pnpm v11 removed `pnpm link --global` and keeps global bins under `PNPM_HOME`;
`pnpm add -g .` fails with `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH` until
`pnpm setup` puts that directory on PATH. Without a global install, replace
`agent-loop` with `node "<repo>/src/cli.mjs"` and quote the repository path so
a path with spaces works, or run `pnpm agent-loop` from the repository root.

## Starting a run

The first dispatch carries the init flags, including `--parent-session` when
the harness provides a session id:

```bash
printf '%s' "<first child prompt>" | agent-loop role dispatch \
  --role <first role> \
  --cwd "<work tree>" \
  --task "<task>" \
  --mode "<mode>" \
  --parent-session "<parent session id>" \
  --worker <cli> --worker-model <model> --worker-effort <level> \
  --reviewer <cli> --reviewer-model <model> --reviewer-effort <level> \
  --max-steps <count>
```

- The first role matches the mode: `worker` in `work-first` and `review-first`,
  `reviewer` in `review-only`.
- `--worker` is required in `work-first` and `review-first` and optional in
  `review-only`, which never dispatches the worker. `--worker-model` and
  `--worker-effort` are always optional, and require `--worker`.
- Always pass `--cwd`. It defaults to the current directory, which for an
  interactive parent is normally not the target work tree.
- Pass the child prompt on stdin. No prompt files.
- A second task in the same session starts a new run with a new init call, and
  only after the previous run is terminal. The subcommand archives the previous
  state file and rejects init over a non-terminal run.
- Later dispatches read the configuration from the state file. Do not repeat
  `--task` on a later dispatch: `--task` keys init detection, so a dispatch
  that carries it while a run is active fails instead of continuing the run.
  Repeating any other init flag with its current value is accepted; changing
  one is rejected, so omit changed flags and never invent new values.

## Dispatch

```bash
printf '%s' "<prompt>" | agent-loop role dispatch --role worker --cwd "<work tree>"
printf '%s' "<prompt>" | agent-loop role dispatch --role reviewer --cwd "<work tree>"
```

Read the JSON envelope on stdout. Example reviewer envelope:

```json
{
  "role": "reviewer",
  "status": "ok",
  "report": { "conclusion": "...", "why": "...", "blockers": "..." },
  "verdict": "accept"
}
```

- `status: "error"` carries `error`. Treat it as not accepted.
- A reviewer envelope carries `verdict`: `accept`, `reject`, or `unknown` when
  the required `Verdict:` line is missing or malformed. Treat `unknown` as not
  accepted. Process success never implies acceptance.
- When the closing block cannot be parsed, `report` is null and `raw` carries
  the tail of the response. Treat a missing report as not accepted.

## Loop policy

- `work-first`: worker, reviewer, worker corrections, reviewer, until
  `verdict: accept`.
- `review-first`: reviewer first, then worker corrections and another review
  if needed.
- `review-only`: reviewer, then report. Findings alone never authorize edits;
  the subcommand rejects worker dispatch in this mode.

## Completion

Completion is completion of the requested work, not code acceptance.

- `work-first` and `review-first`: call `finish` after the reviewer returns
  `verdict: accept` on the latest changed state and the report names the
  checks that passed.
- `review-only`: call `finish` after the reviewer report, whatever the
  verdict. The summary records the verdict in `verified` and the findings in
  `open`.

## Finish output

`finish` reads the summary as JSON on stdin and is accepted only from the
`active` lifecycle. All five keys are required and carry the same keys as the
orchestrator action contract (`validateAction`):

```bash
printf '%s' '{"changed":"...","verified":"...","deferred":"...","notDone":"...","open":"..."}' \
  | agent-loop role finish --cwd "<work tree>"
```

## Blockers and terminal states

- Blocker, `interrupted` lifecycle, or step limit with work remaining: call
  `agent-loop role abort --cwd "<work tree>" --reason "<explanation>"` and
  report the unresolved condition. Never repeat an uncertain turn without a
  maintainer decision.
- `halted` lifecycle (reviewer mutation or snapshot error): the run is already
  terminal and the subcommand rejects further operations, including `abort`.
  Report the failure and the modified paths from the envelope, then stop.
- Every run ends in exactly one terminal lifecycle: `finished`, `aborted`, or
  `halted`. The parent-edit guard (#57, Claude Code, Codex CLI, and OpenCode)
  releases on any of them; any run without `--parent-session` keeps its parent
  unguarded.

## Recovery after compaction or restart

Read the state file at
`<runs root>/<sha256 of the --cwd, shortened>/state.json`, where the runs root
is `<os tmpdir>/agent-loops/runs` by default and the `AGENT_LOOP_RUNS_ROOT`
environment variable overrides it. The directory name is the first 12 hex
characters of the sha256 of the resolved `--cwd`, with the Windows drive letter
lowercased before hashing, so `c:\repo` and `C:\repo` share one directory.
This state-file read is the one exception to the stdout-envelope rule. Honor
the state file's `mode` and `lifecycle`, and continue from `stepsUsed` and
`lastResult`. A resumed review-only task keeps its prohibition on worker
dispatch. From `interrupted`, the parent aborts; only a maintainer may decide
to resume with `dispatch --resume-interrupted`.
