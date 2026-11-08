# 0014. Extend the step budget of a live interactive run

## Status

partially-superseded

Partially superseded by [ADR 0084: Charge no step for a first Codex turn that a model refusal ends](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md). The superseded parts are:

- Decision 5's rule that `turns` keeps its one-entry-per-charged-step rule. Superseded by [ADR 0084](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md): a refunded first-turn model refusal records an entry without a charge, so a budget change still is not a turn.
- The consequence that the ADR 0008 point 5 bound still holds and `turns` never exceeds `maxSteps`. Superseded by [ADR 0084](0084-charge-no-step-for-a-first-codex-turn-that-a-model-refusal-ends.md): the array holds at most `maxSteps` entries plus one refunded first-turn refusal for each role.

Partially superseded by [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md). The superseded part is the consequence that the headless loop is unchanged and that its `--max-steps` stays fixed for the invocation. An invocation still starts its own count at 0, but the budget of a batch loop spans attempts and a continued attempt spends the remainder.

Decisions 1 to 4, 6 to 8, the `budgetChanges` shape, the child guard, the live harness check, and every other consequence stay in force.

## Date

2026-09-30

## Context

`maxSteps` is an init field, so no call changes it on an existing run. A run that
used its whole budget refuses every dispatch with `Step budget exhausted`. The only
way on was `abort` and a new init, which sets every role to `sessionId: null`. Each
role then starts a new session, sends the preamble again, and loses its conversation
history and provider prompt cache. `archiveState` keeps the old ids in
`state.<timestamp>.json`, but nothing reads that file again (issue #361).

## Decision

1. `agent-loop role extend --cwd <dir> --parent-session <id> --max-steps <count>` raises `maxSteps` of a
   non-terminal run in place. The state file stays, so the stored role session ids
   and the first-turn tracking keep working.
2. `--max-steps` uses the parse-time check that init uses (`readMaxSteps`, 1 to
   `Number.MAX_SAFE_INTEGER`). The value must also exceed `stepsUsed` and the
   current `maxSteps`. The operation raises the budget only, and a refusal leaves
   the state file unchanged.
3. `extend` re-checks the stored `maxSteps` like `dispatch` and `finish` (ADR 0008,
   point 7). `abort` stays the route out of a state file with an unsafe budget.
4. `extend` is accepted from `active`, `dispatched`, and `interrupted`, and refuses
   a terminal lifecycle. It leaves the lifecycle as it is, so it neither resumes nor
   recovers an interrupted run. It takes the state lock like every other write.
5. Each change appends `{ from, to, stepsUsed, at }` to a new `budgetChanges` array
   in the state file. `stepsUsed` places the change in the turn sequence: the change
   ran after that many charged turns. `turns` keeps its fixed shape and its
   one-entry-per-charged-step rule (ADR 0008), so a budget change is not a turn.
   A run never extended has no `budgetChanges`.
6. Raising the budget is the user's decision. The orchestrator instructions tell the
   parent to run `extend` only when the user authorized more steps, and to `abort`
   otherwise. Point 7 states what the command enforces.
7. `extend` requires `--parent-session` and refuses a value that differs from the
   stored `parentSession`, the id the parent-edit guard matches (ADR 0006). The
   refusal does not name the stored id. A different `--parent-session` on `dispatch`,
   `finish`, or `abort` is refused by the init-flag check, and that refusal does name
   it. The id check does not identify the calling harness session, so a caller
   that read the id from the state file can pass it, a child role included. The
   check stops a call that omits the id or carries another one.
8. A child caller of the run is refused by a spawn-time marker bound to the run
   (issues #392, #548). `exec` sets `AGENT_LOOP_SPAWNED_RUN=<run keys>` in the
   environment of every worker and reviewer process. The value is a comma-separated
   list: the keys that the spawning process inherited, outermost run first, then the
   key of the run that dispatches the turn. It sets nothing for the orchestrator or
   any other spawn. The run key is the name of the run's state directory, the hash
   that every subcommand uses to find the run state, so the marker and the lookup
   cannot disagree. The hash covers the lexical path with the Windows drive letter
   in lower case. Every descendant inherits the marker, a shell command of the turn
   included. `extend`, `finish`, and `abort` refuse a call whose list holds the key
   they use to find the run state, before any state read, so the run stays as it
   was. A path that spells the work tree another way, such as a symlink alias or a
   different case on a case-insensitive disk, computes another key and finds no
   state, so it cannot reach the run. A child that names the work tree as the run
   does is refused even when that work tree no longer exists, and a parent `abort`
   over a missing work tree still ends the run. A process that holds no marker, or a
   marker of another run, passes. A worker or reviewer that a nested run starts
   through `exec` holds the keys of every enclosing run and of the nested run, so it
   is refused against each of them. The parent path therefore works on every
   supported harness, including a parent session that a child of another run
   started.
   The marker is a boundary against a child that follows its prompt, not against a
   hostile one. These limits remain:
   - A child that clears its environment, or a harness that filters it from shell
     commands, passes.
   - `exec` adds no marker to an orchestrator or a parent, but such a process keeps
     a marker it inherited. A headless orchestrator or an interactive parent that a
     child of the same run started holds that run's key and is refused for it,
     which happens only in the work tree of that run.
     In these cases the id check and the orchestrator instructions are the remaining
     guards.

## Consequences

- A child role cannot end or extend its own run through the CLI while the marker
  reaches its shell. A parent session that a child of another run started keeps
  every parent path for its own run. The limits of point 8 stay. `dispatch` and `wait-checks` stay open to every caller.

- An exhausted run continues with its role sessions and prompt cache.
- The bound in ADR 0008 point 5 still holds: `maxSteps` only grows, so `turns` never
  exceeds it. `budgetChanges` grows by one small entry per `extend`. The strict
  raise and the safe-integer ceiling bound its length. No pruning rule exists.
- The headless loop is unchanged. Its `--max-steps` stays fixed for the invocation,
  and the runtime prompt states that number.

### Live harness check

Issue #549 probes the child refusal of point 8 on live harness sessions. The worker shell
command ran on four of the five harnesses. Copilot CLI denied it. Windows is not probed yet.

#### macOS

Date: 2026-10-10. OS: macOS 27.2, Darwin 27.2.0, arm64. Runtime: the tree at `faf11a5`.
Each harness ran two live runs, each in its own disposable Git repository under the system
temporary directory, with `--worker <harness>` and `--reviewer <harness>`.

The worker turn was asked to run one shell command. The command printed whether
`AGENT_LOOP_SPAWNED_RUN` was set, printed whether its list held the key of the run, and ran
`role abort` for that run. The runtime state file held lifecycle `active` after each worker turn.

| Harness     | CLI version      | Marker in worker shell  | Child `role abort`        | Parent `extend`, `finish`, `abort` |
| ----------- | ---------------- | ----------------------- | ------------------------- | ---------------------------------- |
| Claude Code | 2.1.296          | observed: set, key held | observed: refused, exit 1 | observed: all three ran, exit 0    |
| Codex CLI   | 0.163.0-alpha.5  | observed: set, key held | observed: refused, exit 1 | observed: all three ran, exit 0    |
| OpenCode    | v0.0.0-dev-20800 | observed: set, key held | observed: refused, exit 1 | observed: all three ran, exit 0    |
| Copilot CLI | 1.0.106-2        | observed: set, key held | observed: refused, exit 1 | observed: abort, exit 0            |
| Antigravity | 1.3.3 (`agy`)    | observed: set, key held | observed: refused, exit 1 | observed: all three ran, exit 0    |

- The refusal text was `abort is refused for a child role; only the parent session runs it.`
  Each probe wrote it to a file outside the repository.
- Parent path: the probe shell ran `extend` and `finish` on the first run, and `abort` on the
  second run. That shell held no marker, because the probe unset it. This is not a live
  harness parent session, so the path of a parent session that the harness started is not
  verified.
- OpenCode: the default model, `github-copilot/gpt-5-mini`, and `github-copilot/claude-haiku-4.5`
  each ended the turn with a provider HTTP error (404, 400, 404). A direct `opencode run`
  with the last model also returned HTTP 404. The probe passed with `opencode-go/claude-haiku-5-5`
  and ran the shell command.
- Copilot CLI: the worker shell command was denied in both runs, so the marker and the child
  refusal are not verified. [ADR 0035](0035-state-that-a-copilot-worker-cannot-run-shell-commands-and-flag-a-denied-call.md)
  and [issue #713](https://github.com/andromarces/agent-loops/issues/713) record the denial and its decision.
- 2026-11-02, macOS 27.2 (build 26B123), Copilot CLI 1.0.106-2, agent-loop source
  `97d24a9ac1e3e1391890c1652dd501c5e37c3e12`: a `copilot` shim added
  `--allow-tool 'shell(bash)'` and kept the runtime arguments unchanged. The worker read
  `AGENT_LOOP_SPAWNED_RUN=b20132fb7592,1e2316479229`, `AGENT_LOOP_TEST_SLOT_HELD=unset`, and
  Copilot CLI 1.0.106-2 inside the turn, and the list held the run key `1e2316479229`. The state
  file held lifecycle `active` after the turn. The child `role abort` exited 1, the parent shell then
  ran `role abort`, exit 0, and `extend` and `finish` did not run in this probe. The record saved
  `copilot --version`, `sw_vers`, `uname -a`,
  `node --version`, the work tree head, and the shim invocation log before and after the probe. The
  refusal text was `abort is refused for a child role; only the parent session runs it.`
- Windows: not verified. No Windows host was available.

#### Live parent session

Date: 2026-11-03. OS: macOS 27.2 (build 26B123), Darwin 27.2.0, arm64.
Node v27.0.0-alpha.0.0.0. Source `869fbbbce82598db0517d01a49bb1b8f03a9d86f`.
The CLI versions before and after the probes were identical: Claude Code 2.1.317,
codex-cli 0.167.0-alpha.3, opencode v0.0.0-dev-533.

Each harness ran two nested live sessions in disposable Git repositories with no remote.
Each session ran `role dispatch` init, then the parent operations, through its own shell tool.
The launch cleared `AGENT_LOOP_SPAWNED_RUN` and `AGENT_LOOP_TEST_SLOT_HELD`.
Each nested shell printed both as `unset`. Run 1 ran init, `role extend --max-steps 30`, then
`role finish`. Run 2 ran init in a second repository, then `role abort`.

Each init ran one reviewer turn on `claude` with `--reviewer-model haiku`.
The state files held `roles.reviewer.model` `haiku`.
The checker read each envelope from the tool-output field of the saved stream.
The checker never read the model reply.

- Claude Code 2.1.317: `--session-id` preassigned `c9aa96e8-d94b-440f-8072-8eab2db5e0a0`.
  The saved stream held that id. `extend` exited 0 with
  `{"status":"ok","lifecycle":"active","maxSteps":30,"stepsUsed":1}`.
  The state held one `budgetChanges` entry from 20 to 30 at `stepsUsed` 1.
  `finish` exited 0 with `{"status":"ok","lifecycle":"finished"}`.
  `abort` exited 0 with `{"status":"ok","lifecycle":"aborted"}`.
- Codex CLI 0.167.0-alpha.3: the saved stream held a thread id, which `codex exec` prints after
  the turn starts. The probe used the new UUID `4184c12e-39aa-421c-af23-7a15d4514f39` as
  `--parent-session`. The saved stream held thread id `01a1a0f9-1a01-71f0-aa28-bf5712691236` for
  run 1. It held `01a1a0f9-c05e-7e90-a2cd-a55a0b696c66` for run 2.
  `extend`, `finish`, and `abort` returned the same `status` and `lifecycle` values as the
  Claude Code run.
- OpenCode v0.0.0-dev-533: `--session` preassigned `ses_liveparent710opencodrun1a0001`.
  The saved stream held that session id.
  The probe used `--standalone`, and the tool shell printed both markers `unset`.
  `extend`, `finish`, and `abort` returned the same `status` and `lifecycle` values as the
  Claude Code run.
- Wrong-id mutants: in each harness, `extend` with another `--parent-session` exited 1 with
  `--parent-session does not match the run's parent session.`.
  `finish` and `abort` with another id exited 1 with `--parent-session cannot be changed after init`.
  The state stayed `active` with `maxSteps` 20 after each mutant.
- Marker mutant: in each harness, `abort` with `AGENT_LOOP_SPAWNED_RUN` set to the run key
  exited 1. The refusal read `abort is refused for a child role; only the parent session runs it.`.
  The state stayed `active`. A separate OpenCode session launched with
  `AGENT_LOOP_SPAWNED_RUN=deadbeefcafe` printed `AGENT_LOOP_SPAWNED_RUN=set`.
  The presence check fails on that value.
- The checker passed 150 assertions. Seven changed-evidence mutants each failed one named check:
  presence marker, init parent session, extend envelope, finish lifecycle, wrong-id refusal,
  marker refusal, and abort lifecycle.
- Copilot CLI 1.0.106-5 and agy 1.4.12: not run.
  The item named Claude Code, Codex CLI, and OpenCode.

The earlier record left Copilot CLI and agy untested. This run repeated the shape on both harnesses.

2026-11-03, macOS 27.2 (build 26B123), Darwin 27.2.0, arm64. Node v27.0.0-alpha.0.0.0.
Source `84d62c017925a91623eb654c50298ce6dba45538`.
Copilot CLI was 1.0.106-6 before and after the probes, and agy was 1.4.12 before and after.

Each harness ran two nested live sessions in disposable Git repositories with no remote.
Each session ran `role dispatch` init, then the parent operations, through its own shell tool.
The launch cleared `AGENT_LOOP_SPAWNED_RUN`, `AGENT_LOOP_TEST_SLOT_HELD`, and `AGENT_LOOP_RUNS_ROOT`.
Each nested shell printed `AGENT_LOOP_SPAWNED_RUN=unset` and `AGENT_LOOP_TEST_SLOT_HELD=unset`.
Run 1 ran init, `role extend --max-steps 30`, then `role finish`.
Run 2 ran init in a second repository, then `role abort`.

Each init ran one reviewer turn on `claude` with `--reviewer-model haiku`.
The state files held `roles.reviewer.model` `haiku`.
The checker read each raw tool-output field of the saved session stream.
The checker never read the model reply.

- Copilot CLI 1.0.106-6: `--session-id c0a1b2c3-d4e5-4f60-8172-83940516a7b8` preassigned run 1.
  The saved `result` event held that id, and run 2 used `c0a1b2c3-d4e5-4f60-8172-83940516a7c8`.
  The saved stream held one `bash` tool call per session, and its result field held each envelope.
  `extend` exited 0 with `{"status":"ok","lifecycle":"active","maxSteps":30,"stepsUsed":1}`.
  `finish` exited 0 with `{"status":"ok","lifecycle":"finished"}`.
  `abort` exited 0 with `{"status":"ok","lifecycle":"aborted"}`.
- agy 1.4.12: a first turn returned conversation id `e47aa7d3-1f55-4b0f-a2c4-1925ce5c8ba1`.
  The parent turn ran with `--conversation e47aa7d3-1f55-4b0f-a2c4-1925ce5c8ba1`.
  The parent `init` event held that id. Run 2 used `4d6dadbe-7ef6-4240-9e31-25b13a3b53e8`.
  The saved `run_command` `tool_info.output` field held each envelope.
  `extend`, `finish`, and `abort` returned the same `status` and `lifecycle` values as the
  Copilot run.
- After init, each state file held lifecycle `active`, `maxSteps` 20, and `stepsUsed` 1.
  The state held `parentSession` equal to the harness session id.
  After `extend`, the state held `maxSteps` 30 and one `budgetChanges` entry from 20 to 30 at
  `stepsUsed` 1. The final states held `finished` with `maxSteps` 30, and `aborted` with
  `maxSteps` 20.
- Wrong-id mutants: in each harness, `extend` with another `--parent-session` exited 1 with
  `--parent-session does not match the run's parent session.`.
  `finish` and `abort` with another id exited 1 with `--parent-session cannot be changed after init`.
  The state stayed `active` after each mutant.
- Marker mutant: in each harness, `abort` with `AGENT_LOOP_SPAWNED_RUN` set to the run key
  exited 1. The refusal read `abort is refused for a child role; only the parent session runs it.`.
  The state stayed `active`.
- The checker passed 188 assertions. Five changed-evidence mutants each failed one assertion:
  marker text, final lifecycle, extend `maxSteps`, run key, and parent session id.
  The marker-refusal and extend-exit mutants each failed two assertions.

## Alternatives

1. **Abort and start a new run**: this is the only route without `extend`. It sets every role to `sessionId: null`, so each role loses its history and prompt cache. Rejected.

## Authors

Andro Marces

## Links

- [Issue #361: Raise the step budget of a live interactive run and keep its role sessions](https://github.com/andromarces/agent-loops/issues/361)
- [Issue #392](https://github.com/andromarces/agent-loops/issues/392)
- [Issue #548](https://github.com/andromarces/agent-loops/issues/548)
- [Issue #549](https://github.com/andromarces/agent-loops/issues/549)
- [Issue #713: A Copilot worker turn is denied shell commands that the worker contract requires](https://github.com/andromarces/agent-loops/issues/713)
- [PR #388: feat(role): add extend to raise the step budget of a live run](https://github.com/andromarces/agent-loops/pull/388)
- [PR #541: feat(role): refuse a child caller in extend, finish, and abort](https://github.com/andromarces/agent-loops/pull/541)
- [PR #742: fix(role): reject --reason on finish through one shared flag guard](https://github.com/andromarces/agent-loops/pull/742)
- [PR #876: refactor(role): reuse withOpenRun in extend and dispatchPayload in the dispatch catch](https://github.com/andromarces/agent-loops/pull/876)
- [PR #918: feat(role): declare the run PR after init with role declare-pr](https://github.com/andromarces/agent-loops/pull/918)
- [PR #1300: Deduplicate the runtime, role, and report modules](https://github.com/andromarces/agent-loops/pull/1300)
- Implementation: [`extend`](../src/role/index.mjs), [`rejectMisplacedFlags`](../src/role/args.mjs), [`requireState`](../src/role/state.mjs), and [`isSpawnedByRun`](../src/lib/exec.mjs)
- Tests: [`tests/role.extend.test.mjs`](../tests/role.extend.test.mjs) and [`tests/role.dead-turn-tmpdir.test.mjs`](../tests/role.dead-turn-tmpdir.test.mjs)
- [ADR 0035: State that a Copilot worker cannot run shell commands and flag a denied call](0035-state-that-a-copilot-worker-cannot-run-shell-commands-and-flag-a-denied-call.md)
- [ADR 0006: Require a parent session id for interactive runs](0006-require-parent-session-for-interactive-runs.md)
- [ADR 0008: Keep the turn history in the state file](0008-state-file-turn-history.md)
- [ADR Index](README.md)
