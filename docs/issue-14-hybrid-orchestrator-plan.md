# Plan: Hybrid orchestrator and deterministic runtime (issue #14)

## Status

| Field | Value |
| --- | --- |
| Issue | [#14](https://github.com/andromarces/agent-loops/issues/14) |
| Baseline | `main` at `1b7e404`, `pnpm test` passes 25 tests in `tests/cli.test.mjs` (2026-09-19) |
| Branch | Planned: `feat/issue-14-hybrid-orchestrator` in a dedicated worktree. Not created. |
| State | Awaiting owner review. Design questions resolved on 2026-09-19. No code written. |
| Next action | Owner approves the plan. Then Phase 1: create the worktree and the `lib/` and `contracts/` modules with their tests. |

## Decisions that resolve the issue ambiguities

Decided with the repository owner on 2026-09-19.

| Topic | Decision |
| --- | --- |
| Legacy loop | Remove the fixed worker/reviewer loop, `REVIEW_COMPLETE`, and `--max-reviews`. The orchestrator model is the only mode. |
| `--orchestrator` | Required, like `--worker` and `--reviewer`. |
| Structured output | Uniform for every CLI: the prompt asks for one JSON object, Node validates. Accept a bare object or one inside a ```` ```json ```` fence. No native schema flags. |
| `finish.summary` | Object with five non-empty string keys: `changed`, `verified`, `deferred`, `notDone`, `open`. |
| Child CLI failure | Surfaced to the orchestrator as `{ status: "error" }`. Orchestrator CLI failure is fatal, exit 1. |
| Timeout | One `--timeout <seconds>`, no default. Child timeout kills the child and surfaces an error result. Orchestrator timeout is fatal, exit 1. |
| Mutation check | Runs on reviewer turns and orchestrator turns. Non-Git `--cwd` fails at startup. Detected mutation is fatal, exit 1, no revert. |
| Transcript | Opt-in `--transcript <file>` writes one JSON file on every exit after argv parsing succeeds. An argv parse failure writes no transcript. |
| `--max-steps` default | 20. |
| Plan location | This file, written in the main checkout by owner instruction. |

Routine defaults chosen without a question:

- `Ctrl+C` exits 130 after the active child is killed.
- The repair limit is a constant `1` per orchestrator decision. It is not a flag.
- Repair turns, `finish`, and `abort` do not consume a step.
- No new runtime dependency. Validation is hand-written. `execa` 10.0.1 supplies `timeout` and `cancelSignal`.

## Target layout

```text
src/
  cli.mjs                      argv parsing, help, SIGINT, exit code, transcript write
  runtime.mjs                  step loop, limits, dispatch, mutation check, result envelopes
  orchestrator.mjs             one orchestrator decision: run, extract, validate, one repair
  contracts/
    orchestrator-action.mjs    validateAction(value) -> { ok, value } | { ok, error }
  prompts/
    orchestrator.mjs           initialPrompt, resultPrompt, repairPrompt
    worker.mjs                 workerPrompt(prompt, firstTurn)
    reviewer.mjs               reviewerPrompt(prompt)
  agents/
    index.mjs                  name -> adapter map, normalizeAgent
    claude.mjs
    codex.mjs
    agy.mjs
    opencode.mjs
    copilot.mjs
  lib/
    exec.mjs                   execa wrapper: cwd, stdin, timeout, cancelSignal, typed errors
    json.mjs                   parseJson, parseJsonLines, extractJsonObject
    snapshot.mjs               Git work-tree snapshot and diff for mutation detection
tests/
  cli.test.mjs                 argv validation and exit codes through src/cli.mjs
  runtime.test.mjs             step loop with fake adapters
  orchestrator.test.mjs        decision, repair, unsupported action
  contracts/orchestrator-action.test.mjs
  prompts/orchestrator.test.mjs
  lib/json.test.mjs
  lib/snapshot.test.mjs        real temp Git repository
  agents/claude.test.mjs       exact argv, stdin transport, envelope parsing, read-only flags
  agents/codex.test.mjs
  agents/agy.test.mjs
  agents/opencode.test.mjs
  agents/copilot.test.mjs
  agents/cmd-shim.test.mjs     existing Windows .cmd stdin transport check, moved
adr/
  README.md
  0001-hybrid-orchestrator-runtime.md
```

`runtime.mjs` holds no semantic rule about findings. It moves text between roles and enforces limits.

## CLI contract

```text
agent-loop \
  --orchestrator codex \
  --worker claude \
  --reviewer agy \
  --task "Implement the change."
```

| Flag | Rule |
| --- | --- |
| `--orchestrator <agent>` | Required. Supported names: `claude`, `codex`, `agy`, `antigravity`, `opencode`, `copilot`. |
| `--worker <agent>` | Required. |
| `--reviewer <agent>` | Required. |
| `--orchestrator-model`, `--worker-model`, `--reviewer-model` | Optional string. Passed on every invocation. |
| `--orchestrator-effort`, `--worker-effort`, `--reviewer-effort` | Optional string. OpenCode rules from `assertOpenCodeOptions` apply to all three roles. |
| `--cwd <directory>` | Optional. Resolved with `path.resolve`. Must be inside a Git work tree. |
| `--task <text>` | Required, non-empty after trim. |
| `--max-steps <count>` | Optional positive integer. Default 20. |
| `--timeout <seconds>` | Optional positive integer. Omitted means no timeout. |
| `--transcript <file>` | Optional path. Resolved with `path.resolve` against the launch directory, not `--cwd`. |
| `-h`, `--help` | Print help, exit 0. |

Removed: `--max-reviews`. It now fails as `Unknown argument: --max-reviews`.

Keep the existing `readValue` guard: a missing value, an empty value, or a token that starts with `-` fails with `Missing value for <flag>`. Apply it to every value flag, including `--orchestrator`, `--worker`, `--reviewer`, `--task`, `--max-steps`, `--timeout`, and `--transcript`.

Startup validation order in `cli.mjs`:

1. Parse argv. Any parse error prints the message and exits 1 before any process spawns.
2. Run `git rev-parse --is-inside-work-tree` in `--cwd`. On failure print `--cwd must be inside a Git work tree: <cwd>` and exit 1.
3. Build three role states and call `runLoop`.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Orchestrator returned `finish`. Report printed. |
| 1 | Orchestrator returned `abort`, or a controller error: orchestrator CLI failure, failed repair, unsupported action, mutation detected, orchestrator timeout, argv error, non-Git cwd. |
| 2 | Orchestrator requested a child turn after `--max-steps` was consumed. |
| 130 | `Ctrl+C` received. Active child killed. |

## Orchestrator action contract

`src/contracts/orchestrator-action.mjs` exports `validateAction(value)`.

Accepted shapes. Unknown fields are dropped, never interpreted.

```json
{ "action": "run_worker",   "prompt": "<non-empty string>" }
{ "action": "run_reviewer", "prompt": "<non-empty string>" }
{ "action": "finish", "summary": { "changed": "…", "verified": "…", "deferred": "…", "notDone": "…", "open": "…" } }
{ "action": "abort",  "reason": "<non-empty string>" }
```

Rules:

- Input must be a plain object. Arrays, `null`, strings fail.
- `action` must be one of the four strings. Any other value fails with `Unsupported action: <value>`.
- `run_worker` and `run_reviewer` need `prompt` as a non-empty trimmed string.
- `finish` needs `summary` as a plain object with all five keys, each a non-empty trimmed string.
- `abort` needs `reason` as a non-empty trimmed string.
- Return `{ ok: true, value }` with only the known fields, or `{ ok: false, error: "<one line>" }`.

`src/lib/json.mjs` gains `extractJsonObject(text)`:

1. Trim the text.
2. If it starts with three backticks, remove the first line and the final fence line.
3. `JSON.parse`. On failure return `{ ok: false, error: "Response is not valid JSON." }`.
4. If the value is not a plain object, return `{ ok: false, error: "Response is not a JSON object." }`.
5. Return `{ ok: true, value }`.

Prose before or after the object is malformed. The repair turn handles it.

## Orchestrator decision flow

`src/orchestrator.mjs` exports `decide({ agent, state, prompt, exec options })`.

1. Run the orchestrator adapter with `readOnly: true` inside a mutation check.
2. `extractJsonObject`, then `validateAction`.
3. On success return the action.
4. On failure build `repairPrompt(error)` and run the adapter again in the same session. This is the single repair turn.
5. Extract and validate again. On success return the action. On failure throw `OrchestratorError("Orchestrator returned a malformed action after one repair turn: <error>")`. The runtime maps this to exit 1.
6. Any adapter throw during an orchestrator turn propagates as fatal.

The mutation check wraps both the first attempt and the repair.

## Runtime loop

`src/runtime.mjs` exports `runLoop(options)`.

```js
runLoop({
  task, cwd, maxSteps, timeout, signal,
  roles: { orchestrator, worker, reviewer }, // each { kind, sessionId: null, model, effort }
  agents,                                    // name -> adapter, injectable for tests
  onEvent,                                   // (event) => void, used for console output and transcript
})
```

Algorithm:

```text
stepsUsed = 0
prompt = initialPrompt({ task, maxSteps })
loop forever:
  action = decide(orchestrator, prompt)                 // fatal on failure
  record { type: "action", action, stepsUsed }
  if action is finish:  return { exitCode: 0, summary: action.summary }
  if action is abort:   return { exitCode: 1, reason: action.reason }
  if stepsUsed >= maxSteps:
      return { exitCode: 2, reason: "Step limit reached with work remaining." }
  stepsUsed += 1
  role = action.action === "run_worker" ? worker : reviewer
  result = runChild(role, action.prompt)               // never throws for child failure
  record { type: "result", role, result, stepsUsed }
  prompt = resultPrompt({ result, stepsUsed, maxSteps })
```

`runChild`:

- Worker: `workerPrompt(prompt, firstTurn = state.sessionId === null)`, `readOnly: false`, no mutation check.
- Reviewer: `reviewerPrompt(prompt)`, `readOnly: true`, wrapped in the mutation check. A detected mutation throws `MutationError` with the changed paths. Fatal, exit 1.
- Returns `{ role, status: "ok", response }` or `{ role, status: "error", error }`. `error` is the adapter message, or `"<role> timed out after <n> seconds"` when `timedOut` is set.
- A cancel (`isCanceled`) rethrows so the loop stops. `cli.mjs` maps it to 130.

Step semantics: the last allowed step still returns its result to the orchestrator with `stepsRemaining: 0`. The orchestrator can `finish` for exit 0. Another dispatch yields exit 2.

## Prompts

`src/prompts/orchestrator.mjs`:

- `initialPrompt({ task, maxSteps })` states: the orchestrator role, that it must not edit files or run agent CLIs, the two child roles and their capabilities, that the reviewer is read-only, the step budget and the step definition, the exact four action shapes, the five summary keys, and the rule "Respond with one JSON object and nothing else. A ```` ```json ```` fence is accepted." It ends with the task text.
- `resultPrompt({ result, stepsUsed, maxSteps })` embeds one JSON block: `{ "role", "status", "response" | "error", "stepsUsed", "stepsRemaining" }`, then repeats the one-object rule.
- `repairPrompt(error)` states the validation error and repeats the four shapes and the one-object rule.

`src/prompts/worker.mjs`: `workerPrompt(prompt, firstTurn)`. On the first turn prepend a fixed preamble: the worker implements, runs checks, reports what changed and what it verified, states disagreements with evidence, and does not decide when the loop ends. On later turns return the orchestrator prompt verbatim.

`src/prompts/reviewer.mjs`: `reviewerPrompt(prompt)`. Prepend on every turn: "Do not implement, fix, edit, or change any file. Review, assess, and verify only. Live probes and read-only queries are authorized." Then the orchestrator prompt.

Tests assert the whole prompt strings with equality, as the current suite does.

## Adapter contract

Each adapter exports `run(state, prompt, options)` and returns the response text.

```js
options = { cwd, readOnly, timeout, signal }
state   = { kind, sessionId, model, effort }
```

Shared behavior stays as today: prompt on stdin, newline-free argv, session resume, model and effort pass-through, session mismatch errors.

Read-only flags. Each is added on every invocation, new and resumed, when `readOnly` is true. Verified against the locally installed versions on 2026-09-19.

| CLI | Version checked | Read-only argv addition | Evidence | Gap the mutation check covers |
| --- | --- | --- | --- | --- |
| `claude` | 2.1.277 | `--permission-mode plan` | `claude --help`, docs cli-reference | Plan mode denies edits. Prompts in `-p` without a host are denied. |
| `codex` | 0.156.0-alpha.4 | `-c sandbox_mode="read-only"` | `codex exec --help` lists `-s read-only`. `codex exec resume --help` lacks `-s`, so the shared `-c` override is used on both paths. | Verify once by hand that `exec resume` accepts the `-c` key. |
| `agy` | 1.2.6 | `--mode plan` | `agy --help`: `--mode (accept-edits, plan)` | Workspace writes are auto-allowed by default. Plan mode is the only invocation lever. |
| `opencode` | dev-19794 | `--agent plan` | `opencode run --help`, README: plan denies edits, asks for bash. `run` auto-rejects asks. | A user config that widens the `plan` agent removes the guard. |
| `copilot` | current | `--deny-tool write` | `copilot --help` example `--allow-tool='write'` = all file editing | Shell commands can still write. |

Never add `--yolo`, `--allow-all-tools`, `--dangerously-skip-permissions`, `--auto`, or `--dangerously-bypass-approvals-and-sandbox` for any role.

`src/lib/exec.mjs`:

```js
exec(command, args, { cwd, input, timeout, signal })
```

- Calls `execa` with `reject: false`, `input`, `stdin: "ignore"` when no input, `killDescendants: true`, `timeout: timeout * 1000` when set, `cancelSignal: signal` when set.
- `killDescendants` exists in the installed `execa` 10.0.1 (`types/arguments/options.d.ts`). It terminates shell commands and tools that an agent started. Execa documents it as best-effort. One test spawns a real child that starts a grandchild and asserts that the grandchild exits after cancel.
- Non-zero exit throws `ExecError` with `command`, `exitCode`, `stderr`, `stdout`, and boolean `timedOut` and `isCanceled` copied from the result.
- Returns `{ stdout, stderr }`.

## Mutation detection

`src/lib/snapshot.mjs`:

- `assertGitWorkTree(cwd)`: runs `git rev-parse --is-inside-work-tree`. Throws on non-zero exit or output other than `true`.
- `snapshot(cwd)` records three parts:
  1. Work tree: `git status --porcelain=v1 -z --untracked-files=all`. For every listed path that exists as a regular file, a SHA-256 of the content with `node:crypto`. A sorted array of `{ path, status, hash }`. Deleted paths carry `hash: null`.
  2. Index: SHA-256 of the output of `git ls-files --stage -z`. This covers staged blob ids and modes, so a staged content change with an unchanged status letter is detected.
  3. `HEAD`: output of `git rev-parse --verify -q HEAD`, or the string `unborn` on a non-zero exit. This covers an edit followed by a commit, which leaves the work tree and the index clean.
- `diffSnapshots(before, after)`: returns the sorted list of changed work-tree paths, plus the pseudo entries `<index>` and `<HEAD>` when those parts differ.
- `withMutationCheck(cwd, role, fn)`: take the first snapshot, run `fn()` inside `try`, take the second snapshot in `finally`. The second snapshot runs on success, on an adapter error, on timeout, and on cancel. When the diff is non-empty, throw `MutationError` and discard any adapter error. `MutationError` is always fatal. The message lists the role and every changed entry. Nothing is reverted.

Known limits, documented in the README:

- Ignored files are not tracked.
- A change reverted inside the same turn is not detected.
- Only paths under the Git work tree at `--cwd` are covered. Refs other than `HEAD` are not covered.

## Transcript

`--transcript <file>` writes one JSON object on every exit after argv parsing succeeds, including 130 and fatal errors. An argv parse failure writes no transcript, since the path is not yet known.

```json
{
  "task": "…",
  "cwd": "…",
  "options": { "maxSteps": 20, "timeout": null },
  "roles": { "orchestrator": { "kind": "codex", "sessionId": "…" }, "worker": { }, "reviewer": { } },
  "events": [ { "type": "action", "at": "<ISO>", "stepsUsed": 0, "action": { } }, { "type": "result", "at": "<ISO>", "stepsUsed": 1, "role": "worker", "result": { } } ],
  "exitCode": 0,
  "error": null
}
```

One finalization path in `cli.mjs`: `finish({ exitCode, error })` writes the transcript when a transcript path exists, prints the error when present, then sets `process.exitCode`. Every exit after argv parsing goes through it: `finish`, `abort`, step limit, controller error, mutation error, orchestrator failure, non-Git `--cwd`, and `Ctrl+C`. `events` holds whatever the loop recorded before the exit, or an empty array. Argv parse failures exit before the path is known, so no transcript is written for them. The help text states this. A write failure prints a warning and does not change the exit code.

## Console output

Keep the current banner style. Print `===== ORCHESTRATOR =====` with the validated action JSON, `===== WORKER <n> =====` and `===== REVIEWER <n> =====` with the child response, `===== SUMMARY =====` with the five sections rendered as `Changed:`, `Verified:`, `Deferred:`, `Not done:`, `Open:`. Fatal errors and abort reasons go to `stderr`.

## Tests

Unit tests use fake adapters. No real CLI runs in `pnpm test`. Every test carries a one-line usefulness comment that names the requirement.

Fake adapter for runtime and orchestrator tests: `scripted(replies)` returns `run(state, prompt, options)` that assigns `state.sessionId = state.sessionId ?? "<kind>-<counter>"`, records `{ prompt, options, sessionId }`, and returns the next reply. A reply can be a function to throw or to await `options.signal`.

`tests/runtime.test.mjs`, one test per issue case:

1. Orchestrator dispatches worker first.
2. Orchestrator dispatches reviewer first.
3. Reviewer findings go back to the worker: the worker prompt equals the orchestrator prompt, the second orchestrator prompt embeds the reviewer result.
4. Reviewer reassesses without a worker turn: two `run_reviewer` in a row.
5. Two consecutive worker turns.
6. Finish after a reviewer reports no findings: exit 0, summary object returned.
7. Finish after the orchestrator rejects a stale finding: reviewer result with findings, orchestrator returns `finish`, no worker turn ran.
8. Abort: exit 1, reason surfaced.
9. Step limit: `maxSteps: 2`, third dispatch refused, exit 2, the fake adapters saw exactly two child turns.
10. Last step then finish: `maxSteps: 1`, one child turn, `stepsRemaining: 0` in the prompt, `finish` yields exit 0.
11. Separate session IDs: three roles on the same fake kind hold three distinct `sessionId` values and each resumes its own.
12. Child failure surfaces: worker adapter throws, orchestrator prompt embeds `status: "error"`, run continues.
13. Child timeout surfaces: adapter throws `ExecError` with `timedOut: true`, prompt embeds the timeout message.
14. Orchestrator failure is fatal: adapter throws, `runLoop` rejects, exit 1 in `cli.mjs`.
15. `Ctrl+C`: worker adapter waits on `options.signal`, test aborts the controller, `runLoop` rejects with `isCanceled`, the orchestrator ran once only.
16. Reviewer mutation detected: real temp Git repository, reviewer fake writes a file, `runLoop` rejects with `MutationError` naming the path, the file still exists.
17. Orchestrator mutation detected: same shape as 16 with the orchestrator fake.
18. Mutation on a failed turn: the reviewer fake writes a file and then throws. `runLoop` rejects with `MutationError`, not with a recoverable error result.
19. Mutation by commit: the reviewer fake edits a file and commits it. `runLoop` rejects with `MutationError` naming `<HEAD>`.

`tests/orchestrator.test.mjs`:

1. Malformed JSON gets one repair turn and the repaired action is used.
2. Malformed repair fails the run with the controller error.
3. Unsupported action fails after the repair turn.
4. Fenced JSON is accepted without a repair turn.
5. Unknown fields are dropped from the returned action.

`tests/contracts/orchestrator-action.test.mjs`: `test.each` over every accepted shape and every rejection rule listed in the contract section.

`tests/lib/json.test.mjs`: bare object, fenced object, prose plus object, array, invalid JSON.

`tests/lib/snapshot.test.mjs`: temp repository with `git init`, commit one file. Cases: no change, tracked file modified, untracked file added, file deleted, dirty file modified again, staged blob replaced through `git update-index --cacheinfo` with the work tree unchanged, new commit with a clean work tree, non-Git directory rejected.

`tests/lib/exec.test.mjs`: real subprocess cases. Timeout sets `timedOut`. Cancel sets `isCanceled`. A child that spawns a grandchild through `node -e` and writes the grandchild PID to stdout: after cancel, the grandchild PID is no longer alive. Mark this case as best-effort in its usefulness comment and skip it only if a platform proves flaky in CI.

`tests/prompts/orchestrator.test.mjs`: whole-string equality for `initialPrompt`, `resultPrompt` for an ok result and an error result, and `repairPrompt`.

`tests/agents/*.test.mjs`: keep the current `vi.mock("execa")` pattern and the stdin echo assertion. Per CLI assert exact argv for new and resumed turns with `readOnly: false` and `readOnly: true`, model and effort presence and absence, and envelope parsing. Move the `.cmd` shim test to `tests/agents/cmd-shim.test.mjs` unchanged.

`tests/cli.test.mjs`: keep the `process.argv` plus `vi.resetModules()` pattern. Cases: missing `--orchestrator`, `--worker`, `--reviewer`, `--task`; unsupported agent per role; `--max-reviews` rejected; `--max-steps 0` and `abc` rejected; `--timeout 0` rejected; OpenCode effort rules for `--orchestrator-effort`; the six existing `readValue` cases; non-Git `--cwd` exits 1 before any spawn; `--transcript` file exists after a finish run driven through mocked `execa`; `--transcript` file exists with `exitCode: 1` and a non-null `error` after a non-Git `--cwd` failure; `--transcript` file exists with `exitCode: 2` after a step-limit run; `--transcript` file exists with `exitCode: 1` after an orchestrator failure.

Deleted coverage, by decision: the `REVIEW_COMPLETE` strict-equality test and the four fixed-template tests. Their replacement is the prompts and runtime suites above.

Integration tests against real CLIs stay out of `pnpm test`. Add a manual smoke script section to the README instead.

## Documentation

`README.md`: rewrite around the hybrid model.

- Replace the intro and the diagram with the orchestrator, runtime, worker, reviewer diagram from the issue.
- Replace "Current state", "Concepts", "Usage", "Options", "Completion contract", "Loop", "Exit behavior", "Recommended repository structure", "File responsibilities", "Adapter contract", and "Testing strategy" with the content of this plan.
- Delete "Examples" with `--role`, "Presets", and the `LOOP_COMPLETE` marker text.
- Add "Reviewer safety": the per-CLI read-only table, the external permission configuration each CLI needs, the mutation check and its limits, and the no-revert rule.
- Add "Transcript".
- "Future additions": replace the ordered multi-role controller with "orchestrator-addressable roles", and list the items from the issue's out-of-scope section as future work.
- Link `adr/README.md`.

`adr/0001-hybrid-orchestrator-runtime.md` with the canonical sections. Status `accepted`. Author: Andro Marces. Links: issue #14, the implementation pull request. Alternatives: extend the fixed loop with more branches, the README's planned ordered-role gate controller, and the orchestrator shelling out to child CLIs directly.

`adr/README.md`: the index with number, title, status, summary.

`package.json`: bump `version` to `0.2.0`. `files` already includes `src`.

`AGENTS.md` and `CLAUDE.md`: no change needed.

## Implementation phases

Work in TDD order inside the worktree. Each phase ends with `pnpm test`, `pnpm lint`, `pnpm fmt:check` green.

| Phase | Files | Acceptance |
| --- | --- | --- |
| 1. Foundations | `lib/json.mjs`, `lib/exec.mjs`, `lib/snapshot.mjs`, `contracts/orchestrator-action.mjs`, their tests | All contract and lib tests pass. `snapshot` tests run against a real temp Git repository. `exec` tests run real subprocesses. |
| 2. Adapters | `agents/*.mjs`, `agents/index.mjs`, `tests/agents/*.test.mjs` | Existing adapter behavior preserved. Read-only argv asserted per CLI. `.cmd` shim test moved and green. |
| 3. Prompts and orchestrator | `prompts/*.mjs`, `orchestrator.mjs`, their tests | Repair path and unsupported action tests pass. |
| 4. Runtime | `runtime.mjs`, `tests/runtime.test.mjs` | All 19 runtime cases pass with fake adapters. |
| 5. CLI | `cli.mjs`, `tests/cli.test.mjs` | Old loop code deleted. Exit codes 0, 1, 2, 130 covered. Transcript written. |
| 6. Docs | `README.md`, `adr/README.md`, `adr/0001-hybrid-orchestrator-runtime.md`, `package.json` | README matches the CLI help text. ADR index linked. |
| 7. Manual smoke | none | One real run with three installed CLIs completes with exit 0. One run with a reviewer forced to write a file exits 1 with `MutationError`. Record the shortest decisive output in the pull request. |

Manual smoke commands, run from a scratch Git repository:

```bash
agent-loop --orchestrator codex --worker claude --reviewer agy --max-steps 4 --timeout 600 --transcript ../run.json --task "Add a README line that names the project."
codex exec resume <id> -c sandbox_mode="read-only" --json -   # verifies the resume read-only override once
```

## Git and pull request workflow

1. `git worktree add ../agent-loops-issue-14 -b feat/issue-14-hybrid-orchestrator main`.
2. Verify `.env` is in `.gitignore` before the first commit. It is, at `1b7e404`.
3. Commit per phase with `feat:`, `test:`, `docs:` prefixes. Never pass `--no-verify`.
4. Pull request title `feat: hybrid orchestrator with deterministic runtime`. Body: `Closes #14`, the ADR filename `adr/0001-hybrid-orchestrator-runtime.md`, the smoke evidence, and the breaking flag change `--max-reviews` to `--max-steps`.
5. Labels: `enhancement`, `breaking-change` if the label exists, else `enhancement` only.
6. Remove the worktree after the push. Keep the remote branch until merge.

## Acceptance checklist

- `agent-loop` requires `--orchestrator`, `--worker`, `--reviewer`, `--task`.
- The orchestrator chooses every child turn. `runtime.mjs` contains no rule that reads reviewer text.
- Only validated actions run. Unknown fields are dropped.
- Three independent session IDs persist across turns, including three roles on one CLI.
- Reviewer and orchestrator turns run with read-only flags and a mutation check. A mutation fails the run with the paths listed and no revert.
- `--max-steps` and the repair constant cannot be changed by the orchestrator.
- The final report comes from `finish.summary`.
- All five adapters remain available with unchanged stdin transport.
- Exit codes 0, 1, 2, 130 behave as the table states.
- README, help text, and ADR describe the same contract.

## Risks

| Risk | Handling |
| --- | --- |
| Codex `exec resume` rejects `-c sandbox_mode` | Phase 7 smoke check. Fallback: pass `-s read-only` on the first turn only and document the resume gap. |
| Copilot non-interactive runs need `--allow-all-tools` per its help text | Pre-existing adapter behavior. Out of scope. Document the required external `--allow-tool` configuration in the README. |
| Orchestrator writes prose around JSON on every turn | The repair turn recovers once per decision. The `initialPrompt` states the one-object rule twice. |
| `git status` on a large work tree slows every read-only turn | Acceptable for the first implementation. Note the cost in the README. |
| Windows `SIGINT` delivery to Node differs from POSIX | `process.once("SIGINT")` fires on `Ctrl+C` in a Windows console. The test drives the `AbortController` directly. |
| Descendant termination is best-effort in Execa | `killDescendants: true` is the only cross-platform lever available. The README states that a tool an agent detached from its process tree can survive a cancel. |
