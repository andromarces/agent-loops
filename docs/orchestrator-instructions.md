# Orchestrator instructions (harness-neutral)

You are the parent orchestrator for an `agent-loop role` run. Per-harness entry
points (the Claude Code, Codex CLI, and Antigravity CLI skills, the OpenCode
plugin command, and the Copilot launcher) include this file instead of copying
it. The headless prompt in `src/prompts/orchestrator.mjs` states the same role
rules in JSON-action form; this file is the source for shared rules. Work tree
ownership below is stated in that prompt as well, and the two state the same
rule.

The rules that only some turns need are in the reference files under `orchestrator/`. The
Reference sections list below names each file and when to read it.

## Role

- Delegate the task, track results, handle blockers, and report completion.
- Never implement changes, never review code yourself, never run tests, never
  open child transcripts.
- The one exception is a pull request check status read, which a run that ends
  with `--require-ci` allows, as the [waiting rules](orchestrator/waiting-for-checks.md) state. A status read is
  not a review, not a test, and not an edit, and `agent-loop role wait-checks` is
  the only command it covers.
- Never write to GitHub or any remote: do not create, edit, comment on, review,
  merge, push, or otherwise change an issue, a pull request, a branch, or any
  other remote state. A status read, such as `agent-loop role wait-checks`,
  changes nothing, so it is not a write. The runtime does not detect a remote
  write, so this rule is advisory.
- Read only the JSON envelope the subcommand prints on stdout. Child stderr
  logs and child response text beyond the envelope are not input.

## Inputs to collect from the invocation

Collect these before the first dispatch:

- the task
- worker CLI, model, and effort (`--worker`, `--worker-model`, `--worker-effort`)
- reviewer CLI, model, and effort (`--reviewer`, `--reviewer-model`, `--reviewer-effort`)
- mode: `work-first`, `review-first`, or `review-only` (`--mode`)
- maximum steps (`--max-steps`)
- the PR number when the task is PR work (delivered on a pull request); the run
  supplies it, and a headless run names it in the task
- the test command, when the operator names one (`--test-cmd`, with the optional
  `--test-cmd-timeout`); the operator supplies it, and no turn sets it
- the sandbox of the Codex reviewer (`--reviewer-sandbox read-only` or
  `workspace-write`; with no flag the reviewer runs with no sandbox); the
  operator supplies it, and no turn sets it

## Resolving the CLI

The command blocks below call `agent-loop` directly. Install and link steps are in
the reference sections [Install](reference/install.md#install) and
[From a clone (development)](reference/install.md#from-a-clone-development).

If `agent-loop` does not resolve on PATH, replace it with
`node "<repo>/src/cli.mjs"` and quote the repository path, so a path with spaces
works. Or run `pnpm agent-loop` from the repository root.

## Starting a run

The first dispatch carries the init flags, including the required
`--parent-session`. The subcommand refuses an init without it, so an interactive
run is never left unguarded:

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

- The first role matches the mode: `worker` in `work-first`, `reviewer` in
  `review-first` and `review-only`. The subcommand refuses only `--role worker`
  in `review-only`; it accepts either role at a `review-first` init, so the Loop
  policy section sets the order.
- `--worker` is required in `work-first` and `review-first` and optional in
  `review-only`, which never dispatches the worker. `--worker-model` and
  `--worker-effort` are always optional, and require `--worker`. An OpenCode
  `--<role>-effort` also requires an explicit `--<role>-model`.
- Always pass `--cwd`. It defaults to the current directory, which for an
  interactive parent is normally not the target work tree.
- Pass every child prompt on stdin, from a shell heredoc or an equivalent such as
  `printf`. The exception is an init with `--task-file -`, which takes
  `--prompt-file`. While a run is active, the parent guard denies the file-edit
  tools of the parent for every path, including a scratch path outside the work
  tree, so a later prompt never goes through a file. A piped `cat <file>` of a
  file that was never written gives an empty stdin, and `dispatch` refuses it:
  `Prompt on stdin is empty. Pipe a prompt or use --prompt-file.`
- The init task (`--task` or `--task-file`) reaches each child conversation once. The first turn of a
  conversation shows the task under its own `Init task:` label, before `Instructions:`. This holds in the worker
  preamble and in the reviewer prompt. A later turn of the same conversation does not repeat it.
  - The delivery rules cover `taskSentTo`, a replacement conversation, the task-only turn, and
    a cancel. They are in [Init task delivery](orchestrator/task-delivery.md).
  - The headless loop passes its task the same way. The `Instructions:` text is still the prompt of the
    dispatch, so write it to state the work of that turn.
- `--task-file <path>` can replace `--task` on init. Before you stage that file or init with it, read
  [Init with a task file](orchestrator/task-file-init.md).
- A parent session can drive several runs at once, one per work tree. Init
  registers each run under the session as its own entry keyed by the work tree,
  so a second run in a different work tree does not replace the first. A new
  task in the same work tree starts a new run only after that work tree's
  previous run is terminal; the subcommand archives that work tree's previous
  state file and rejects init over a non-terminal run there.
- Later dispatches read the configuration from the state file. Do not repeat
  `--task` or `--task-file` on a later dispatch: they key init detection, so a dispatch
  that carries either while a run is active fails instead of continuing the run.
  `finish`, `abort`, and `extend` always refuse `--task-file`. They refuse
  `--task` only when its value differs from the stored task.
  Repeating any other init flag with its current value is accepted; changing
  one is rejected, so omit changed flags and never invent new values. The one
  exceptions are the step budget, which only `role extend` changes, and the model of a role with no
  completed turn, which only `role set-model` changes (see below).

## Dispatch

```bash
printf '%s' "<prompt>" | agent-loop role dispatch --role worker --cwd "<work tree>"
printf '%s' "<prompt>" | agent-loop role dispatch --role reviewer --cwd "<work tree>"
```

A run that set `--test-cmd` at init passes the same `--test-cmd "<command>"` on
every reviewer dispatch, as [Reviewer prompts and runtime evidence](orchestrator/reviewer-evidence.md) states.
A run that set `--reviewer-sandbox` at init needs no flag on a later
dispatch: the state file holds the mode. A later dispatch that names another
mode is refused.

Read the JSON envelope on stdout. The envelope is one JSON line, with no indent. A
background task can merge stdout, child stderr logs, and a harness trailer such as
`[exited with code 0]` into one output file. In that file, select the last line that
starts with `{`, and parse only that line. Never search for a multi-line block.
The example below is indented for display only. Example reviewer envelope:

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

- `status: "error"` carries `error`. Treat it as not accepted.
- An error envelope can carry `"transient": "capacity"`. It means the last failure
  event of the Codex turn was the model capacity reply (`Selected model is at
  capacity. Please try a different model.`), a provider outage and not a reviewer
  fault. A turn is not marked when its last parsed `error` or `turn.failed` event
  carries another message. Consecutive capacity failures stay marked. The runtime
  ignores a malformed or truncated final line, so an earlier capacity event stays
  decisive then. The turn charged its step and gave no review result. Dispatch
  the same turn again, after a short wait, without reading the `error` text. Raise the budget with `extend`
  when no step is left. An error with no `transient` field is not known to be
  transient. Only the Codex adapter sets the field.
- A reviewer envelope carries `verdict`: `accept`, `reject`, or `unknown` when
  the required `Verdict:` line is missing or malformed. Treat `unknown` as not
  accepted. Process success never implies acceptance.
- When the closing block cannot be parsed, `report` is null and `raw` carries
  the whole response, so no text the block held is lost. Treat a missing report
  as not accepted.
- `report.checks` names the commands that ran in that child turn and their
  results, for a worker turn and for a reviewer turn alike. It is reported
  evidence from the child, not proof that a command ran, so it never replaces
  the runtime `reviewed` fields. The label is optional, so a child that omits it
  yields `null` and the block still parses.
- `report.notes` holds non-blocking findings the next turn does not need to act
  on. `report.deferred` holds items found but left out of scope. Both are
  optional: a child that omits the label yields `null` for that field, and the
  block still parses. Each value is one line, the label plain at column 0.
  The rules that fold a list under a label into that value, and the shapes that make the
  block unparseable, are in [Closing block list rules](orchestrator/closing-block.md).

A reviewer envelope carries `reviewed`, the runtime-owned identity of the state
the reviewer saw. The runtime writes these fields from the snapshot taken at the
start of the turn, so the child cannot misreport them: `head` is the commit,
`clean` is true when the work tree has no uncommitted entries, `exact` is true
when every entry has a content hash or is a deletion, and `digest` identifies the
uncommitted state (it is exhaustive only when `exact` is true; ignored files are
out of scope).

A task is PR work when its change is delivered on a pull request. For PR work,
name the PR branch in the worker prompt: the worker commits its change on that
branch and pushes it, so the PR head equals the reviewed head. The run supplies
the PR number, and the head commit comes from that PR. In a headless run, the
task names the PR number. After each push, when the branch has an open PR, the worker
updates the PR body in place so that it describes the pushed head. It adds no
revision log to the body or to a comment. The body describes only the committed
or published repository state and names no untracked file, local-only change,
local probe, or machine-specific path.

Apply these parent rules:

- Compare reviewed.head with the PR head before finish; for PR work, resolve the
  PR head from the run's PR number.
- Require reviewed.clean: true for PR work.
- When a PR resolves its issue only in part, read the commit messages of the PR branch before
  finish. A closing keyword in one, such as `Closes #N`, closes the issue at merge, even after the
  PR body says `Refs`. Dispatch a worker to remove it.
- A worker envelope carries `workTree`, the runtime-owned `head` and `clean` state read after
  the turn. For PR work, when `workTree` shows `clean: false`, dispatch a worker to commit or
  discard the leftover change, not a reviewer.
- A worker envelope carries `sharedGitChanged` only when the turn changed shared Git state outside
  the work tree: `core.hooksPath`, a file in the common `hooks/` directory, or a remote. The field
  names the items, such as `core.hooksPath`, `hooks/pre-push`, and `remote.origin`, and never a
  value or a URL. A change there affects the main work tree and every other linked work tree, and
  `workTree` does not show it. Report it in the finish summary under `open`. A failed or canceled
  worker turn carries the field too. A turn that changed none carries no field. A read of the
  shared Git state that fails or passes its 10 second deadline after the turn reports no field, so
  the absent field then does not prove that no change happened. The runtime logs a warning for
  such a read.
- A worker envelope carries `lockfileChanged` only when the turn changed a lockfile at the work
  tree root, for example `pnpm-lock.yaml` after a merge of the base branch. The field names the
  lockfiles by path only. A lockfile that the runtime could not read before or after the turn counts
  as changed. When the runtime could not read the work tree root, the field names every lockfile,
  which can include a lockfile that does not exist: reinstall anyway (issue #1225). The worker
  never installs, so the installed dependencies no longer match
  the lockfile. When the field appears, run the lockfile install in that work tree, for example
  `pnpm install --frozen-lockfile`, before the next reviewer dispatch (issue #1180). A failed worker
  turn carries the field too. A turn that changed none carries no field.
- A reviewer envelope carries `inheritedTmpdirEntries` only when entries appeared directly in the
  inherited temporary directory during the turn. It is advisory: the runtime cannot attribute an
  entry to the turn, and it does not delete one. A name with the prefix `registered/` is the turn
  directory of another agent-loop process, most likely a concurrent run: the prefix is a hint,
  not proof. Report it in the finish summary under `open`, and
  do not treat it as a reason to reject (issue #1024). Field rules:
  [Runtime advisory fields](orchestrator/runtime-advisory-fields.md).
- A reviewer envelope carries `packageStoreEntries` only when entries changed during the turn in
  the pnpm package store that the work tree records as `storeDir`. It is advisory: the runtime
  cannot attribute a change to the turn, and it does not revert one. Report it in the finish
  summary under `open`, and do not treat it as a reason to reject (issue #1045). Field rules:
  [Runtime advisory fields](orchestrator/runtime-advisory-fields.md).
- Treat an accept without a Checks line as not accepted. Only the reviewer
  Checks line is a gate input, so a worker Checks line is reported evidence and
  never an accept.
- When the PR head cannot be resolved, do not finish as verified. Abort, or record the unresolved
  compare under notDone and open in the finish summary. A recorded compare also
  sets the marker described under Finish output, so the record never reads the
  same as a verified finish. That marker is the only machine-readable record of
  the compare, and nothing else in the run distinguishes an omitted marker from a
  verified finish, so always set it.

## Work tree ownership

The parent creates the run's work tree and owns it. Keep that work tree in place
for the whole run, and never tell a worker to remove it: a worker turn pushes its
branch and stops there, because every later dispatch of that run targets the same
`--cwd`.

Create the work tree with no upstream, so a plain `git push` of a worker cannot
reach the default branch:

```bash
git worktree add --no-track -b <branch> <work tree> origin/<default>
```

Without `--no-track`, the new branch gets the upstream `origin/<default>` when
`branch.autoSetupMerge` is at its default.
The worker sets the upstream to its own remote branch on the first push, with
`git push -u origin <branch>`.

The no-upstream rule guards a plain `git push` only when `push.default` follows
the upstream. With `push.default=matching`, a plain `git push` pushes every
local branch that has a remote branch of the same name. A linked work tree
shares its local branches with the main checkout. So a local default branch that
is ahead of `origin/<default>` is pushed too.

Tell the worker to push only with a named refspec. Use `git push -u origin <branch>`, or
`git push -u origin <pr branch>` for an existing PR branch. Never let the worker
run a plain `git push`. Before the first dispatch, read
`git -C "<work tree>" config push.default`. If it prints `matching`, state the
named push in the task text.

The named push closes the gap only when the worker follows it. A worker that
runs a plain `git push` anyway can push the default branch under `matching`.

A run on an existing pull request, such as a review or a correction of PR #N, must
run on the PR head branch. A repository with no remote has no `origin/<default>`.
The setup for both, and the per-work-tree `push.default` override, are in
[Work tree setup details](orchestrator/work-tree-setup.md).

The parent installs the dependencies of the work tree, and no worker or reviewer
does. After you create the work tree and before the first dispatch, run the
repository's lockfile install inside the work tree, for example
`pnpm install --frozen-lockfile`. The work tree then has its own `node_modules`
for every turn. Never link or junction the `node_modules` of another checkout into
the work tree, and never run an install in another checkout: a tool such as `vp`
can rewrite links in the `node_modules` that the junction points to.

`dispatch` checks the work tree before it reads the run state, charges a step, or
spawns a child, so a refused `--cwd` leaves the run as it was: the init call
writes no state file, and a later dispatch charges no step, changes no lifecycle,
and spawns no child. The envelope carries `status: "error"` with
`--cwd must be inside a Git work tree: <path>`.

A failed first turn keeps the session id its output printed, so the next dispatch
resumes that session and the edits the failed turn left. When a resume fails
because the CLI has no such session, the runtime clears the id and reruns the turn
once as a first turn, with the worker preamble and the `Init task:` block. A reviewer rerun gets the
`Init task:` block too. That rerun is part of the step the dispatch already charged: it charges no second step and adds no `turns` entry.

When `--cwd` is a linked work tree, the init call copies the untracked local files of the
main work tree that `--cwd` ignores, such as agent instructions and `.env`, into `--cwd`.
Do not read, print, or quote any copied file. The copy duplicates secrets such as `.env`
into the run work tree, so remove that work tree when the run ends. The copy rules,
`--no-copy-local-files`, `--copy-local-path`, and `localFilesDiffer` are in
[Local files copied into the work tree](orchestrator/local-files-copy.md).

Remove the work tree only after the run is terminal. A `finish` or `abort` envelope
with `status: "ok"` carries `lifecycle: "finished"` or `lifecycle: "aborted"`. A refused
`finish` or `abort` prints `status: "error"` and no `lifecycle`, and the run keeps its
lifecycle, `active` or `interrupted`. A dispatch that halts the run (reviewer mutation
or snapshot error) also prints no `lifecycle`, as does a child error that leaves the run
`active`. Read the state file ([Recovery](#recovery-after-compaction-or-restart)):
remove the work tree after it reads `halted`. Run the removal as a separate command
after you read the result. Never chain it after `finish` or `abort` in one command.

Remove the work tree as [Removing a work tree](orchestrator/work-tree-removal.md) states.
Never delete it with a recursive delete that follows junctions: it can damage the shared pnpm store.

A refused `--cwd` is not the parent's to repair: end the run, name the path and
the refusal in the reason, and leave the work tree to a maintainer, who decides
whether to recreate it and start a new run.

Abort only when a non-terminal run exists at the refused `--cwd`. With no run
state there, from a refused init or a path that was never this run's, no run
started, so report the refusal and do not abort. A run that is already terminal
needs no abort.

One rule covers every refused `--cwd`: a path that no longer exists, a path that
is not inside a Git work tree, and an existing work tree path whose Git metadata
is lost all report `--cwd must be inside a Git work tree: <path>`, so the reason
names that path and that message.

```bash
agent-loop role abort --cwd "<work tree>" \
  --reason "<work tree>: --cwd must be inside a Git work tree"
```

`abort` reads only the state file, so it ends the run over a work tree that is
gone or is not a Git work tree, and it writes nothing inside that path. It needs
a non-terminal run at that path: a path with no run state is refused with
`No run state for <path>`, and a terminal run is refused with
`Run is already <lifecycle>.`, so neither is a command to run there. A maintainer
who recreates the work tree starts a new run there: a run over an aborted work
tree is not resumed, and the state file names the work tree, not the work in it.

The headless loop states the same rule and cannot act on it: `agent-loop`
snapshots its `--cwd` before and after every orchestrator turn, so a work tree in
any of those three states ends the run on that snapshot failure before the
orchestrator can act, and the run keeps no state file. A headless worker turn
gets the ownership rule from the same file, because `runChild` builds the worker
prompt there for both paths.

## Reference sections

The files below hold the rules that most turns do not need. Read a file in full when its
condition holds, before you act on that condition. Each path is relative to the directory
of this file.

- [Init task delivery](orchestrator/task-delivery.md): read it when a turn reports a replacement
  conversation, a missing session, a cancel, or a task-only turn.
- [Closing block list rules](orchestrator/closing-block.md): read it when a child report holds a
  list, or when `report` is null and `raw` carries the response.
- [Runtime advisory fields](orchestrator/runtime-advisory-fields.md): read it when a reviewer
  envelope carries `inheritedTmpdirEntries` or `packageStoreEntries`.
- [Reviewer prompts and runtime evidence](orchestrator/reviewer-evidence.md): read it before you
  write a reviewer prompt, when a reviewer envelope carries `prChecks` or `testRun`, when the
  run sets `--test-cmd`, and when the reviewer could not run tests. Read it after any worker or
  reviewer envelope that carries `shellDenied`, before the next dispatch.
- [A change outside the work tree](orchestrator/out-of-tree-change.md): read it before init when the
  task changes state outside the work tree, and before the reviewer prompt of such a task.
- [Codex reviewer sandbox mode](orchestrator/reviewer-sandbox.md): read it when the run uses a
  Codex reviewer, sets `--reviewer-sandbox`, or halts on a reviewer mutation.
- [Waiting for required checks](orchestrator/waiting-for-checks.md): read it before a run that ends
  with `--require-ci` dispatches its reviewer, and when a reviewer reports a pending required check.
  Read it when a required check fails on a known flaky test. Read it when `wait-checks` returns an
  error, `noRequiredChecks`, or `noCheckSource`.
- [Declaring the PR when a worker opens it](orchestrator/pr-declaration.md): read it when the PR
  does not exist at init, or when a headless run declares its PR itself.
- [Finish gates](orchestrator/finish-gates.md): read it when a `finish` is refused, and before you
  end a run with `--require-accept` or `--require-ci`.
- [Turn history and the step budget](orchestrator/run-history.md): read it when you rebuild a run
  after compaction or restart, or when a stored `maxSteps` or sandbox mode is out of range.
- [Local files copied into the work tree](orchestrator/local-files-copy.md): read it before init
  when `--cwd` is a linked work tree, when the task needs ignored reference data of the main work
  tree, and when an envelope carries `localFilesDiffer`.
- [Removing a work tree](orchestrator/work-tree-removal.md): read it when you remove the work tree
  of a terminal run, before the removal command.
- [Headless compare-head and undeclared PR](orchestrator/headless-compare-head.md): read it when a
  headless run passes `--compare-head`, when a run has no usable required-check source, and when
  a headless run finishes with a worker-opened PR.
- [Shared tracking artifacts](orchestrator/shared-tracking-artifacts.md): read it before you
  dispatch several runs in one repository, so no two runs create the same tracking issue or take
  the same sequential identifier, such as an ADR number.
- [Work tree setup details](orchestrator/work-tree-setup.md): read it before you create the work
  tree for a repository with no remote or for a run on an existing PR, and when
  `extensions.worktreeConfig` is on.
- [Finish with --compare-head](orchestrator/finish-compare-head.md): read it before you finish with
  `--compare-head <pr>`, and when that finish is refused.
- [Init with a task file](orchestrator/task-file-init.md): read it before you stage a task file, before
  any init with `--task-file`, and before a later init in a session with an active run.
- [Parent session id after init](orchestrator/parent-session-guard.md): read it when a new session
  resumes a run, and before a call that passes `--parent-session` after init.
- [Child run guard](orchestrator/child-run-guard.md): read it when a child role ran `extend`,
  `declare-pr`, `finish`, or `abort`, or when a call is refused for `AGENT_LOOP_SPAWNED_RUN`.

## Several runs at once

One parent session can drive several runs, one per work tree. Each run registers
its own session entry keyed by the work tree, so a second run in a different
work tree does not replace the first, and the parent-edit guard stays engaged
while any of the session's runs is non-terminal.

- Interleave: dispatch one turn per run in turn, and read each envelope before
  the next dispatch. This works in every harness.
- Background: run each dispatch as a background shell command where the harness
  supports it, and read each envelope when it completes.

Every command for a run passes that run's `--cwd`. Each run ends with its own
`finish` or `abort`, and the guard releases only after every run is terminal.

Runs on one host share the test slot table, whose default count is 1 (ADR 0046).
A targeted test run with `--if-held` waits while any slot is held (ADR 0044). A
reviewer turn can then wait behind a full suite of another run. That wait, or
exit 75 from the wrapper, can leave a reviewer turn with no local test run. The
required CI checks are then its only test evidence, as
[Reviewer prompts and runtime evidence](orchestrator/reviewer-evidence.md) states.
A parent that starts concurrent runs can raise `AGENT_LOOP_TEST_SLOTS` before the
first dispatch, but 2 slots overloaded both measured hosts (ADR 0046).

Workers of runs in one repository can each create the same shared tracking issue, or take the same
sequential identifier, such as the next ADR number. Rules:
[Shared tracking artifacts](orchestrator/shared-tracking-artifacts.md).

## Loop policy

- `work-first`: worker, reviewer, worker corrections, reviewer, until
  `verdict: accept`.
- `review-first`: reviewer first, then worker corrections and another review
  if needed.
- `review-only`: reviewer, then report. Findings alone never authorize edits;
  the subcommand rejects worker dispatch in this mode.

Both paths name the mode with `--mode <mode>`, with the same three values: on the
`role` init call and on the headless `agent-loop` command. The headless `--mode`
is off by default, so a run without the flag keeps the current behavior. A
`review-only` run dispatches no worker, so it takes none of `--pr`,
`--require-accept`, and `--require-ci`. The Completion section states the finish
rule.

The headless gate follows turn order only; an edit made outside the loop after a
reviewer accept is not detected. `agent-loop --require-ci <pr>` applies the same
PR gate headlessly, so the runtime resolves the PR head there too (#293), and
`--pr <pr>` on either path declares the run PR work, so that run can only end
through the gate for the same PR (#302). A
headless gate refusal is satisfied by a reviewer turn, and the run ends on exit 1
when a finish is refused again with no child turn in between, so budget
`--max-steps` for a required check that is still pending. The gate reads the
reviewed state, so the reviewer turn is the one that satisfies it; a worker turn
resets that state to none, so it is needed first only when the condition is about
the change. A
headless finish that records an unresolved PR-head compare sets
`"unresolvedCompare": true` on the action; the run records an
`unresolved-compare` transcript event and exits `4` instead of `0`, so the
recorded finish stays distinct from a verified one without a transcript (#266,
#279). An interactive `role finish` records the same marker in its envelope and
the state file instead of a transcript event (#281).

A headless run on a repository whose required-check sources are unreadable passes
`--compare-head <pr>` for a PR that exists at start (#1104), and a run without the flag
resolves a worker-opened PR itself (#1111, ADR 0053). The rules, the refusals, and the
exit codes are in
[Headless compare-head and undeclared PR](orchestrator/headless-compare-head.md).

A headless orchestrator action allows only these keys. The `run_worker` and
`run_reviewer` actions allow only `action` and `prompt`. The `abort` action
allows only `action` and `reason`. An action that holds any other key is
refused, and the refusal names each unknown key, so a misspelled field is never
dropped without a trace. A refused action takes the one repair turn: it
dispatches no child and charges no step. A second refused reply ends the run
with an error (#1034).

## Completion

Completion is completion of the requested work, not code acceptance.

- `work-first` and `review-first`: call `finish` after the reviewer returns
  `verdict: accept` on the latest changed state and the report names the
  checks that passed.
- `review-only`: call `finish` after the reviewer turn, whatever it returned. The
  gate is on the turn, not on a report: a turn that ended in an error satisfies
  it, so the finish can carry no report. The runtime checks that all five
  summary keys are non-empty strings. It refuses a finish that holds any other
  key and names each unknown key: the headless action object allows only
  `action`, `summary`, and an optional boolean `unresolvedCompare`, and its
  nested `summary` object allows only the five summary keys. The `role finish`
  stdin object allows the five summary keys and an optional boolean
  `unresolvedCompare`. It never compares the summary content with what the
  reviewer returned.

A `review-only` finish needs a reviewer turn that ran, whatever it returned. The
runtime does not compare the summary with the reviewer result. Record the
reviewer status and verdict in `verified`, including an error or a missing
report.

- `agent-loop role finish` applies no reviewer-turn rule of its own. Every
  reachable interactive run already has a reviewer turn, because the init
  dispatch is itself that turn.
- A headless `--mode review-only` run can reach a finish before any reviewer
  turn. The runtime refuses that finish until a reviewer turn was dispatched. A
  `run_worker` action ends the headless run on exit 1 with the reason
  `mode review-only rejects a run_worker action`.
- Neither path takes `--require-accept` in this mode. `role finish` refuses the
  flag at `finish`, and the headless command refuses it before the run starts.
  Both give this error:
  `--require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.`

Call `finish` after the reviewer turn, whatever it returned. Record what the run
did not cover in `notDone` and `open`.

Map the child report fields into the finish summary:

- Carry each `Deferred` item forward from every worker or reviewer turn. An item
  leaves the list when a later worker turn reports it done and a later reviewer
  `accept` covers that state; record it in `changed`. The items that remain at
  `finish` go into `deferred`.
- A reviewer `accept` can leave a criterion unverified, because the reviewer
  turn cannot run its check, for example a live run against a production
  service, a device, or a manual step. Its `Checks` line reports the criterion as
  unverified, and its `Deferred` line lists it. Carry it into `deferred`, and
  name the unrun check in `verified` as not verified. Do not dispatch another
  turn to run that check, unless the task states that the check must pass in
  this run.
- Reviewer `Notes` that no later turn addressed go into `open`.
- Do not send an accepted note to the worker automatically. To act on a note,
  dispatch the worker for that change, then obtain another reviewer `accept` on
  the new state before `finish`.
- `review-only`: `Blockers` and `Notes` go into `open`, and reviewer `Deferred`
  items go into `deferred`. `deferred` holds out-of-scope items in every mode;
  `open` holds unresolved in-scope findings.

## Finish output

`finish` reads the summary as JSON on stdin and is accepted only from the
`active` lifecycle. All five keys are required and carry the same keys as the
orchestrator action contract (`validateAction`):

```bash
printf '%s' '{"changed":"...","verified":"...","deferred":"...","notDone":"...","open":"..."}' \
  | agent-loop role finish --cwd "<work tree>"
```

A finish that records an unresolved PR-head compare instead of aborting sets
`"unresolvedCompare": true` beside the five keys, the same marker the headless
finish action carries beside its summary:

```bash
printf '%s' '{"changed":"...","verified":"not verified: PR head unresolved","deferred":"...","notDone":"PR head unresolved","open":"PR head unresolved","unresolvedCompare":true}' \
  | agent-loop role finish --cwd "<work tree>"
```

The value must be a boolean, and the key is not one of the five summary keys:
`summary` keeps exactly those five. A refused finish keeps the lifecycle,
`active` or `interrupted`. The stdin object allows only the five
summary keys and `unresolvedCompare`. The headless finish action object allows
only `action`, `summary`, and `unresolvedCompare`, and its nested `summary`
object allows only the five summary keys. A finish with any other key in
either object, such as a misspelled marker, is refused and the refusal names
each unknown key; resend the finish with only the allowed keys (#1021). The
envelope then carries
`"unresolvedCompare": true` and the state file records the same field beside
`summary`, so a recorded unresolved compare never reads the same as a verified
finish, which keeps the current envelope and state (#281). A finish with the
field absent, or set to `false`, is a verified finish. The marker cannot be
combined with `--require-ci`: that gate resolves the PR head itself, so a
compare it verified is not unresolved. A run that cannot use `--require-ci`,
for example one whose base branch requires a check this credential cannot read,
finishes with `--compare-head <pr>`, or records the marker when it cannot
read the PR head. A base branch whose required-check sources each state that it
holds no required check can use the gate, which verifies the PR head, the clean
reviewed tree, and the merge state.

A run that cannot use `--require-ci` finishes with `--compare-head <pr>`, for a repository
whose required-check sources are unreadable (#301, #1098). The runtime reads the PR head and
state and refuses the finish unless the PR is open, its head equals `reviewed.head`, and the
reviewed tree is clean. A closed or merged PR refuses even when its head is unchanged. The runtime
reads no required-check source or check result and claims none, so `verified` still states what
the checks showed. A finish that also sets `unresolvedCompare` is refused, because the compare
resolves that head. Dispatch the reviewer again when the PR head moved, then repeat the finish. The
command and the `headCompare` record are in
[Finish with --compare-head](orchestrator/finish-compare-head.md).

Without the gate or `--compare-head`, the runtime never resolves the PR head, so it cannot tell an
absent field from a verified compare. A finish that records the compare under
notDone and open and omits the field is a verified finish to every machine
consumer, and the free text is the only trace. `--require-ci` closes the gap in
both paths, because it resolves the head in the runtime: `agent-loop role finish
--require-ci <pr>` here, and `agent-loop --require-ci <pr>` in the headless loop
(issue #286, accepted gap; #293). A run with no usable gate, for example one
that cannot read the required checks, keeps the marker as its only trace.

## Declaring a PR run

`--pr <pr>` on the init call declares that this run's work is delivered on that
pull request. The declaration is the run's PR input, so such a run can only end
through the gate: `agent-loop role finish --require-ci <pr>` here, and
`agent-loop --require-ci <pr>` in the headless loop, with the same PR number.

- A `finish` with no `--require-ci` is refused, and a `finish` whose
  `--require-ci` names another PR is refused without reading GitHub. That refusal
  is the only way the interactive path can catch a wrong number, because its
  `--require-ci` arrives at `finish`. The headless path takes both flags on one
  command line, so `agent-loop --pr 42 --require-ci 7` is a usage error before the
  run starts.
- A `finish` that sets `"unresolvedCompare": true` is refused, because the gate
  resolves that compare. The recorded marker is the accepted gap above, and a
  declared run does not have it. One refusal names every condition the finish
  broke above the `--require-ci` gate, so read all of it rather than the first
  reason. The interactive `finish` reads the gate only after those conditions
  pass, so a later `finish` can report a `--require-ci` condition that the first
  refusal did not name. A matching gate applies its own conditions on top of the
  declaration, and a gate for another PR is never read.
- The gate flag is a run input, so no `dispatch` supplies it and a repeat
  `finish` is refused the same way. A declared run with no gate can only end
  through `abort` with the missing gate named in the reason.
- `--pr` is an init field, so a later call that changes it is refused like any
  other init field. The one exception is `role declare-pr`, below. A state file
  written before this field has no `pr`, and that run keeps the marker-only
  behavior.
- `review-only` refuses `--pr` at init, because that mode rejects `--require-ci`
  at finish and the run would refuse every finish. On the headless path every
  flag arrives on one command line, so `--mode review-only` with `--pr`,
  `--require-accept`, or `--require-ci` is a usage error before the run starts,
  with the same two wordings this section states.
- A base branch with no required check does not refuse `--pr` when every
  required-check source stated that it holds none. The gate passes on the PR head,
  the clean reviewed tree, and the merge state, and the run records it, so a
  declared run on such a branch ends and never keeps the #286 gap. A base branch
  whose required checks this credential cannot read still refuses every finish,
  because the gate cannot establish the absence, and the refusal names the source
  it could not read.
- Omit `--pr` when the repository rulesets of the PR base branch are unreadable to
  the gate, for example a private repository on the GitHub Free plan (#301), because
  a declared run there refuses every finish and can end only through `abort`.
  Init with `--pr`, `role declare-pr`, and the headless start read the required-check
  sources of the PR base once. They refuse when the rulesets read settled nothing,
  before any state file is written or child spawns. A read that fails for another
  reason, such as a transport failure, warns and does not refuse. A `--continue-from`
  run that restored its PR makes no start read, because the earlier run read at the
  start of its own `--pr` run or before it declared a worker-opened PR, and its
  prompt states none. After a refusal, omit
  `--pr` and finish with `--compare-head <pr>`, which compares the PR head with
  `reviewed.head` in the runtime and requires the PR to be open. Use the `"unresolvedCompare": true` marker only
  when the PR head itself cannot be read. The headless `--require-ci` with no
  `--pr` declares nothing, so the start does not read it and its gate refuses at
  finish.

A run that declares no PR keeps the accepted gap: the runtime has no PR input, so
an omitted marker still reads as a verified finish. The declaration closes the
gap for a run that states its PR (issue #302). A headless run that takes neither
`--pr` nor `--require-ci` can also gain its PR from the runtime, as
[Declaring the PR when a worker opens it](orchestrator/pr-declaration.md) states.

The conditions that the `--require-accept` and `--require-ci` gates check at `finish` are in
[Finish gates](orchestrator/finish-gates.md).

## Blockers and terminal states

- Blocker or `interrupted` lifecycle: call
  `agent-loop role abort --cwd "<work tree>" --reason "<explanation>"` and
  report the unresolved condition. Never repeat an uncertain turn without a
  maintainer decision.
- Step limit with work remaining (`Step budget exhausted`): if the user
  authorized more steps, raise the budget with
  `agent-loop role extend --cwd "<work tree>" --parent-session "<parent session id>" --max-steps <count>`, then
  dispatch again. Otherwise call `abort` and report the unresolved condition.
  Never raise the budget on your own to avoid a stop the user set. A child
  role never runs `extend`, `declare-pr`, `finish`, or `abort`. The spawn marker and its
  limits are in [Child run guard](orchestrator/child-run-guard.md).
- `extend` changes the budget in place on the same state file, so each role
  keeps its stored session and the run does not send the preamble again. Do not
  abort and start a new run to gain steps: that starts every role on a new
  session and loses its conversation history. `<count>` must be larger than both
  `stepsUsed` and the current `maxSteps`, and follows the `--max-steps` range
  in [Turn history and the step budget](orchestrator/run-history.md). `extend` works from `active`, `dispatched`, and `interrupted`, leaves
  the lifecycle as it is, and refuses a terminal run. An `interrupted` run still
  needs `abort` or `dispatch --resume-interrupted`.
- `declare-pr` sets the run PR once after init, as the section on declaring a PR
  run states. The caller must pass the stored `--parent-session` id, as for `extend`.
- A CLI refuses a role model on the first turn of that role (for example `The 'gpt-6.1' model is not supported`): do not abort. Run `agent-loop role set-model --cwd "<work tree>" --parent-session "<parent session id>" --reviewer-model <valid model>` (or `--worker-model`), then dispatch again. It needs an `active` run and a role with no `ok` turn. Ask the user for the valid model.
- `halted` lifecycle (reviewer mutation or snapshot error): the run is already
  terminal and the subcommand rejects further operations, including `abort`.
  Report the failure and the modified paths from the envelope, then stop.
- Every run ends in exactly one terminal lifecycle: `finished`, `aborted`, or
  `halted`. The parent-edit guard (#57, Claude Code, Codex CLI, Copilot CLI,
  OpenCode, and Antigravity CLI) releases on any of them. Every `agent-loop role`
  init requires `--parent-session`, so the guard always has a parent to match.
  The headless `agent-loop` command is the explicit unguarded path.

## Repeated rejects of one finding class

After two rejects in a row for the same finding class, restate the blocker bar in the next reviewer prompt, or ask the maintainer. The bar: a failure scenario must be an input that the task or its constraints can meet in normal use. A deliberately constructed input that only defeats a heuristic goes in Notes, not in Blockers, unless the task states adversarial inputs as in scope. Never narrow the bar for a weakened existing guard or a regression on an input in normal use. The fixed review scope carries the same bar, as [Reviewer prompts and runtime evidence](orchestrator/reviewer-evidence.md) states (issue #1194).

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
`dispatch --resume-interrupted` exits 1 and names the process when a live process still holds the
Claude session of the role. Do not end that process. The maintainer ends it or waits for it.

A run keeps the `--parent-session` of the session that started it. How each subcommand treats the
flag after init is in [Parent session id after init](orchestrator/parent-session-guard.md).
