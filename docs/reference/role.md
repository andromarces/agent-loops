# Child dispatch

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

Operations: `dispatch` (default), `finish`, `abort`, `extend`, `declare-pr`, `wait-checks`.

- The run state lives at a fixed path derived from the resolved `--cwd` (`<os tmpdir>/agent-loops/runs/<sha256 of cwd, shortened>/state.json`, with `state.lock` beside it). There is no `--state` flag; `AGENT_LOOP_RUNS_ROOT` overrides the root for tests only.
- `--no-copy-local-files` and `--copy-local-path <relative path>` are init fields that control the copy of local files into a linked `--cwd`. A later call that names another value is refused, like every other init field, and a refused init writes no state and spawns no child. The init envelope carries `localFiles: {"copied": [...], "skipped": [...]}` when the copy ran, and no such key otherwise. A later dispatch adds `localFilesDiffer: [...]`. The copy rules, the refused paths, and the comparison are in [Local files in a linked work tree](harness-entry-points.md#local-files-in-a-linked-work-tree) and [Local files copied into the work tree](../orchestrator/local-files-copy.md).
- The init call requires `--parent-session`, so a run through `role` is always guarded, and the headless `agent-loop` command is the explicit unguarded path. The refusals of a missing id and of an unexpanded placeholder are in [ADR 0006](../../adr/0006-require-parent-session-for-interactive-runs.md).
- The init call registers one session entry per run under `<root>/session-runs/<parent-session>/`, so a parent guard hook (#57) can look a run up by session id even when `--cwd` is a different work tree, and one parent session can drive several runs at once. The entry layout and the legacy `<root>/sessions/<parent-session>` file are in [Parent guard details](../parent-guard.md).
- `role dispatch` blocks until the child turn ends and prints one envelope, so read each envelope before the next dispatch. The rules for several loops from one parent session are in [Several runs at once](../orchestrator-instructions.md#several-runs-at-once).
- `--task-file <path|->` replaces `--task` on the init call. `--task` and `--task-file` cannot be combined, and an empty file is refused. The stdin form, the staging rules, and the rules for a later dispatch are in [Starting a run](../orchestrator-instructions.md#starting-a-run) and [Task delivery](../orchestrator/task-delivery.md).
- Prompts come from stdin by default, or `--prompt-file`. `finish` reads the five-key summary as JSON on stdin; `abort` takes `--reason`.
- `extend --max-steps <count> --parent-session <id> [--cwd <dir>]` raises the step budget of a non-terminal run in place, so the stored role session ids and first-turn tracking keep working. The caller must pass the stored `--parent-session` id. Every change is appended to `budgetChanges` as `{from, to, stepsUsed, at}` (ADR 0014). A child role of the run is refused through the `AGENT_LOOP_SPAWNED_RUN` marker that the runtime sets in the environment of every worker and reviewer process (issues #392 and #548, ADR 0014 point 8). The refusal rules, the limits of the id check and of the marker, and the unguarded run of a resumed session (issue #435, ADR 0021) are in [Blockers and terminal states](../orchestrator-instructions.md#blockers-and-terminal-states) and [Recovery after compaction or restart](../orchestrator-instructions.md#recovery-after-compaction-or-restart).

- `declare-pr --pr <pr> --parent-session <id> [--cwd <dir>]` sets `pr` once on a non-terminal run that declared none at init, for a task whose worker opens the pull request. After it the run behaves as one that passed `--pr` at init. The refusals, the envelope, and the follow-up steps are in [Declaring the PR when a worker opens it](../orchestrator/pr-declaration.md) (ADR 0041).
- `wait-checks --pr <pr> [--all [--expect <check name>]...] [--head <sha>] [--cwd <dir>] [--timeout <seconds>]` waits for the required checks of that pull request and prints one JSON envelope whose `head` names the commit that `checks` describe. It reads status only, writes no run state, needs no init, and returns inside its own bound. A pass is never read from an unresolved read, a `timedOut: true` envelope, or an envelope that carries `prFailures`. The full contract is in [wait-checks](wait-checks.md).
- The state file records `task`, `mode`, `cwd`, `parentSession`, `maxSteps`, `timeout`, `stepsUsed`, `lifecycle`, `pr` (the declared run PR, or `null`), `roles.{worker,reviewer}.{kind,model,effort,sessionId}` (`roles.worker` is null in `review-only`), `lastDispatch` (with `turnTmpdir`, the private temporary directory and child pid of a Codex turn), and `lastResult`, plus `budgetChanges` after an `extend`, `summary` or `reason` when terminal, `unresolvedCompare` when a finished run recorded an unresolved PR-head compare, `noRequiredChecks` when a gated finish passed on a base branch with no required check, and `resumeDecision` when a maintainer resumed an interrupted run. Updates are atomic (temp file plus rename); exclusive access uses `state.lock` with a stale-lock check on the owner pid.
- Every run keeps a turn history without `--transcript`: `turns` holds one entry per charged step, in order, each with `role`, `status`, `verdict`, `head`, and `at`, and report and response text stay out. The entry shape, the `interrupted` status, the size bound, and the accepted `--max-steps` range (1 to 9007199254740991, `Number.MAX_SAFE_INTEGER`) with its re-check at `dispatch`, `finish`, and `extend` are in [Turn history and the step budget](../orchestrator/run-history.md).

- Lifecycle values: `active`, `dispatched`, `interrupted`, `halted`, `finished`, `aborted` (terminal: `halted`, `finished`, `aborted`). A turn interrupted between the CLI start and the state write leaves `dispatched` with a dead lock owner; the first call after the crash marks it `interrupted`, exits non-zero, and never repeats the turn, even with `--resume-interrupted`. From `interrupted`, only `abort` or an explicit `dispatch --resume-interrupted` is accepted. `--resume-interrupted` refuses while a live process holds the session of the dispatched Claude role. The refusal, its timing, the retry, and the unreadable process table are in [ADR 0031](../../adr/0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md) and [ADR 0032](../../adr/0032-detect-a-live-session-holder-on-interactive-init.md).
- The lock is fail-closed on ambiguity: a contender that finds a lock it cannot read, or whose owner has not finished writing it, exits non-zero and never removes it. Only a lock whose owner reads as dead, or an unparseable lock that no writer can own, is stale. One contender removes it under a claim file `state.lock.reap.<digest>`, a fixed-length name keyed by the SHA-256 of the guarded file name and its stale content, and only if the lock still holds the content that was read as stale, so a lock that a new owner created in between survives. A chain of more than two crashed claims fails closed. Lock creation is an atomic hard link, with an exclusive-create fallback on file systems that have none (FAT/exFAT, some network mounts).

  The owner is a pid plus a platform start-time stamp (issue #498), so a reused pid reads as a new owner. Reading the stamp costs one `powershell.exe` startup on Windows. It was measured on 2026-10-23 (issues #511 and #709) on Windows 11 Pro 10.0.26220 with 16 CPUs, Windows PowerShell 5.1.26100.9739 (Desktop edition), and Node v26.8.1, while other runs loaded the host (CPU load 21% before and 63% after the samples, about 45 `node` processes running). Over 15 fresh Node processes that each read their own stamp, the median was 804 ms and the range was 763 to 1207 ms, every read returned a valid stamp, and a bare Node start took a median of 64 ms on the same host. A cold start after a reboot and an idle host were not measured.

  The orphan-claim removal (issue #452), the stamp forms, the PID namespace rule, and the limits are in [ADR 0020](../../adr/0020-remove-orphan-claim-files-with-a-writer-liveness-check.md).

- The reviewer turn runs under the same `withMutationCheck` as the headless loop: a detected mutation or snapshot error is fatal, keeps the charged step, and sets `halted`. No further dispatch is possible; the next run needs a new init call, which archives the halted file as `state.<timestamp>.json`.
- An init call is refused while a live process holds a Claude role session that the current or an archived state file of the work tree records. The match rule, the refusal, the unreadable process table, and the headless gap are in [ADR 0032](../../adr/0032-detect-a-live-session-holder-on-interactive-init.md).
- `mode: review-only` rejects `--role worker` as a hard guard and does not require `--worker` at init. `finish` is completion of the requested work, not code acceptance, and it is accepted from `active` in any mode. The review-only completion rules and the five-key finish summary are in [Completion](../orchestrator-instructions.md#completion) and [Finish output](../orchestrator-instructions.md#finish-output).
- `--mode <mode>` on the headless `agent-loop` command names the same three values the `agent-loop role` init call takes, and `--mode review-only` takes none of `--pr`, `--require-accept`, and `--require-ci`. The loop policy is in [Loop policy](../orchestrator-instructions.md#loop-policy), and the headless behavior, the refusal wording, and the transcript fields (issue #337) are in [Usage](usage.md).

- `--pr <pr>` on the init call declares that the run's work is delivered on that pull request, so the run can only end through the `--require-ci <pr>` gate for the same PR. A private GitHub Free-plan repository still refuses a declared run, so it must omit `--pr`. `--pr` is an init field that a later call cannot change, except `declare-pr`. The refusals, the headless usage errors, the base branch with no required check, and the accepted gap of a run with no declared PR (issues #286, #302) are in [Declaring a PR run](../orchestrator-instructions.md#declaring-a-pr-run).

- `--test-cmd <command>` and `--test-cmd-timeout <seconds>` on the init call make the runtime run the command in `--cwd` before each reviewer dispatch, outside the reviewer sandbox, and put the result in the reviewer prompt, in the envelope as `testRun`, and in `lastResult` in the state file. Pass the same `--test-cmd` on every reviewer dispatch: a changed or missing value is refused before a step is charged. The command runs inside a machine-wide test slot ([ADR 0040](../../adr/0040-run-the-test-command-in-a-test-slot.md)), and a `slot-timeout` is neither a pass nor a failure. The approved orphan-process limit is in [ADR 0017](../../adr/0017-run-a-test-command-before-each-reviewer-turn.md). The result fields, timeouts, cancel handling, redaction, and work-tree reporting are in [Reviewer prompts and runtime evidence](../orchestrator/reviewer-evidence.md#the-runtime-supplies-a-test-command-result).

- `--reviewer-sandbox read-only|workspace-write` on the init call sets the sandbox of each Codex reviewer dispatch ([ADR 0038](../../adr/0038-run-the-codex-reviewer-with-no-sandbox-by-default.md), which partially supersedes [ADR 0019](../../adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md)). `--reviewer-workspace-write` stays as an alias of `--reviewer-sandbox workspace-write`. The flag needs `--reviewer codex`, and any other reviewer is refused at init before a state file is written. The modes, the stored `reviewerSandbox` field, and its refusals are in [Codex reviewer sandbox mode](../orchestrator/reviewer-sandbox.md) and [Turn history and the step budget](../orchestrator/run-history.md).
- Two opt-in finish gates apply to `work-first` and `review-first`: `--require-accept` and `--require-ci <pr>`. Each refusal names the failed condition. In `review-only`, a flagless `finish` keeps the current behavior and each gate fails with a clear error. The conditions, their refusal order, and the no-required-check pass (`noRequiredChecks`, issue #336) are in [Finish gates](../orchestrator/finish-gates.md). The absence rule is in [Finish gates: absence rule](finish-gates.md), and the classes of source replies are in [ADR 0012](../../adr/0012-establish-the-absence-of-a-required-check.md).

- Live verification of the classic-protection absent-check refusal with a non-admin `GITHUB_TOKEN` is recorded in [PR #285](https://github.com/andromarces/agent-loops/pull/285). The disposable probe repository was deleted after [issue #296](https://github.com/andromarces/agent-loops/issues/296); the recorded result does not depend on it.
- The reviewer prompt carries a fixed review scope on every turn, which sets what a blocker is (issue #1073) and, when the task names a pull request, a required-check read that `--require-ci` still enforces (issues #313 and #317). A run that declares `--pr` also gets a runtime-read advisory status before each reviewer turn (issues #320, #349, and #350). A required check that is still pending after a wait is not a finish condition (issue #319). The wait is a status read that changes nothing and is the one exception to the orchestrator role rule: a status read is not a review, not a test, and not an edit, and `agent-loop role wait-checks` is the only command it covers (issue #348). The rules are in [Reviewer prompts and runtime evidence](../orchestrator/reviewer-evidence.md) and [Waiting for required checks](../orchestrator/waiting-for-checks.md), and the headless wait command and its limits are in [ADR 0013](../../adr/0013-bound-the-headless-required-check-wait.md).

- The reviewer closing block tells the reviewer to state each blocker concretely in the `Blockers` line and never to point at text outside the block, for example "the defects above". The parent reads only the closing block, so a pointer leaves the worker without the defect (issue #434). The block keeps its one-line, no-list format.
- The worker first-turn prompt has the same rule for every result the parent needs, such as findings, drafts, decisions, and open questions: each stands in full inside the closing block, and the worker never points at text outside it, for example "the decisions above" (issue #976).
- The reviewer is required to end with one explicit `Verdict:` line (`accept` or `reject`, parsed case-insensitively) inside its closing block. The verdict word alone, the word closed by a sentence period (`reject.`), or the word followed by a separator and a trailing clause (`reject — the state does not pass`) parses to that word, unless the clause names either verdict as a whole word. Any other malformed value, including a missing line or a line that names both verdicts, yields `verdict: unknown`; process success never implies acceptance.
- `--transcript <file>` appends one JSON line per `invocation` and `result` event, in the same shape as the headless mode, accumulating across calls. It stays a per-call flag; the `turns` array above is the history every run keeps without it.

Stdout carries exactly one JSON envelope, except for `role --help` and `role -h`, which print plain usage text and exit 0. All logs go to stderr.

A string error message prints unchanged. A message of `null` or `undefined` is not serialized. The error is then the text of the whole error value, for example `Error: null` for an `Error` and `[object Object]` for a plain object. Outside a handled child error, any other message value serializes once under the key `error`, exactly as the envelope serialized it before. Its JSON type and its `toJSON` redaction are kept, and a state file that records the result holds the same value. A message that serializes to `null`, such as `NaN`, `Infinity`, or a `toJSON` that returns `null`, then prints JSON `null`.

A value that cannot serialize, or that serializes to nothing (a function, a Symbol, or a `toJSON` that returns `undefined`), prints a fixed text instead. The fixed text is `[unserializable message]`, or the digits of a BigInt. The envelope therefore never fails to stringify, and an error envelope always carries `error`.

A handled child error result carries text, not a JSON value. A non-string value that the serialization yields prints as its JSON text, so `null` prints the string `"null"`. A string value, such as one that a `toJSON` returns, prints unchanged. A handled child error that timed out prints `<role> timed out after <seconds> seconds` instead of its message.

A message that throws when read prints `Unreadable error`, except for a handled child error that timed out. Before the child turn starts, a message that throws a canceled error prints `Interrupted by SIGINT` instead. Only a message that throws after the child turn starts ends with a recorded result in the state file.

If the stdout write itself fails, for example on a closed pipe, no envelope can be delivered. The command then writes `Failed to write the envelope to stdout: <code>` to stderr. It exits 1 when the command outcome was exit 0, otherwise it keeps that non-zero exit code:

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

`report` is parsed from the closing block every child turn must end with. `conclusion`, `why`, and `blockers` are required; `checks` (the commands that ran and their results), `notes` (non-blocking findings), and `deferred` (out-of-scope items) are optional, and an omitted or empty label yields `null` for that field without making `report` null. Every child turn is asked for a `Checks` line, for a worker turn and a reviewer turn alike (issue #310), but only the reviewer `Checks` line is a gate input, so a worker `Checks` line is reported evidence and never an accept. Each label takes one line, plain at column 0.

The closing-block list rules fold a `- ` or ordered list under a report label into that label's value, and any other list shape makes the block unparseable. The full rules are in [Closing block list rules](../orchestrator/closing-block.md). When parsing fails, `report` is null and `raw` carries the whole response. `status: "error"` carries `error`, and every error path still prints one JSON object. The subcommand launches no orchestrator model and accepts no `--orchestrator` flags.

A reviewer envelope carries `reviewed`: `{ head, clean, exact, digest }` from the snapshot the runtime takes before the reviewer turn, so the child cannot misreport it. A reviewer turn in a run that named a PR also carries the advisory `prChecks` status that the runtime read for that PR head, and the state file keeps it in `lastResult`. The fields, the `unresolved` cases, and the rule that a run with no PR carries none are in [Reviewer prompts and runtime evidence](../orchestrator/reviewer-evidence.md#the-runtime-supplies-the-required-check-status) (issues #320 and #350).

`head` is the commit, `clean` is true when the work tree has no uncommitted entries, `exact` is true when every entry has a content hash or is a deletion, and `digest` identifies the uncommitted state. A symlink hashes its link target text with a tag, so two links with different targets have different digests, dangling included, and a link never collides with a regular file that holds the same bytes.

The `finish` envelope is `{ "status": "ok", "lifecycle": "finished" }`, and the command exits 0. A finish that recorded an unresolved PR-head compare adds `"unresolvedCompare": true`, and a verified `finish --compare-head <pr>` adds `"headCompare": "verified"` (#1098, #1021). The summary keys, the marker, and the `--compare-head` guards are in [Finish output](../orchestrator-instructions.md#finish-output).
