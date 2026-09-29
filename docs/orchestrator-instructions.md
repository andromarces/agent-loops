# Orchestrator instructions (harness-neutral)

You are the parent orchestrator for an `agent-loop role` run. Per-harness entry
points (the Claude Code, Codex CLI, and Antigravity CLI skills, the OpenCode
plugin command, and the Copilot launcher) include this file instead of copying
it. The headless prompt in `src/prompts/orchestrator.mjs` states the same role
rules in JSON-action form; this file is the source for shared rules. Work tree
ownership below is stated in that prompt as well, and the two state the same
rule.

## Role

- Delegate the task, track results, handle blockers, and report completion.
- Never implement changes, never review code yourself, never run tests, never
  open child transcripts.
- The one exception is a pull request check status read, which a run that ends
  with `--require-ci` allows, as the waiting rules below state. A status read is
  not a review, not a test, and not an edit, and `agent-loop role wait-checks` is
  the only command it covers.
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

## Resolving the CLI

The command blocks below call `agent-loop` directly. Install the CLI globally:

```bash
npm install -g @andromarces/agent-loops
```

Then run `agent-loop install` once to write the harness entry points and guards
at user scope.

From a clone, run `npm link` in the clone, then `agent-loop install`. `npm link`
writes the bin shim to the global prefix bin directory and points the rendered
entries at the clone. That directory must be on PATH for `agent-loop` to
resolve: it is the `npm prefix -g` directory on Windows and
`$(npm prefix -g)/bin` on macOS and Linux. After the clone moves, run
`npm link --force` from the new location, then `agent-loop install` again; a
plain `npm link` fails with `EEXIST` on Windows when a shim already exists.
`pnpm link` is not a supported path: pnpm 12 `link` has no global mode. Without a
link, replace `agent-loop` with `node "<repo>/src/cli.mjs"` and quote the
repository path so a path with spaces works, or run `pnpm agent-loop` from the
repository root.

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

- The first role matches the mode: `worker` in `work-first` and `review-first`,
  `reviewer` in `review-only`.
- `--worker` is required in `work-first` and `review-first` and optional in
  `review-only`, which never dispatches the worker. `--worker-model` and
  `--worker-effort` are always optional, and require `--worker`. An OpenCode
  `--<role>-effort` also requires an explicit `--<role>-model`.
- Always pass `--cwd`. It defaults to the current directory, which for an
  interactive parent is normally not the target work tree.
- Pass the child prompt on stdin. No prompt files.
- A parent session can drive several runs at once, one per work tree. Init
  registers each run under the session as its own entry keyed by the work tree,
  so a second run in a different work tree does not replace the first. A new
  task in the same work tree starts a new run only after that work tree's
  previous run is terminal; the subcommand archives that work tree's previous
  state file and rejects init over a non-terminal run there.
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
  block still parses. Each value is one line, the label plain at column 0. A list
  anywhere in the closing block, for example bullets under any label, after the
  reviewer `Verdict:` line, or a bullet with no space after the marker, makes the
  block unparseable, so the list surfaces through `raw` instead of being dropped.
  An indented label or a decorated label does the same. This covers a label that
  already holds a value, including the required `blockers`, and a label
  occurrence that a later repeat shadows. A non-list line, for example a closing
  sentence, does not make the block unparseable. A `*` line is not always a
  list, and one shape is the case that matters here: a `*` line whose closing
  `*` a letter precedes, where the character right after the close is not a word
  character or `*`, and where nothing glued from that character on is a letter
  or an ASCII digit, for example `*file*` or `*use a* b`. Such a line is
  dropped without `raw` under any label, and every matching line in the block
  drops the same way, so the block still parses with the text gone (issue #275,
  accepted gap).
  A child is told to write no block line that starts with `*`. Every other `*`
  line either is a list and blanks the block, for example `*item`, `* item`, or
  `*file*.mjs`, or is not a list and drops as prose, for example `**bold** note`.

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
task names the PR number.

Apply these parent rules:

- Compare reviewed.head with the PR head before finish; for PR work, resolve the
  PR head from the run's PR number.
- Require reviewed.clean: true for PR work.
- Treat an accept without a Checks line as not accepted. Only the reviewer
  Checks line is a gate input, so a worker Checks line is reported evidence and
  never an accept.
- When the PR head cannot be resolved, for example a read-only turn with no
  network access, do not finish as verified: abort, or record the unresolved
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

`dispatch` checks the work tree before it reads the run state, charges a step, or
spawns a child, so a refused `--cwd` leaves the run as it was: the init call
writes no state file, and a later dispatch charges no step, changes no lifecycle,
and spawns no child. The envelope carries `status: "error"` with
`--cwd must be inside a Git work tree: <path>`.

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

## Reviewer prompts

The reviewer prompt sets the task scope; the fixed review scope and closing
block wrap it on every turn. Name the guards and contracts that the change puts
at risk, so the reviewer can trace each changed input through them. Do not
restate the spec as the pass condition: a restated spec asks the reviewer to
confirm it, not to test it.

The fixed review scope also carries the required-check rule. The rule text is in
every reviewer prompt. It applies only when the task names a pull request, and
then every reviewer turn reads `gh pr checks <pr> --required` for the reviewed
head. The command reads status only, so the reviewer stays read-only. Every
rule below belongs to that one condition, so the prompt nests them under it:

- When the task names a pull request, read the required checks for the reviewed
  head with `gh pr checks <pr> --required`. The command reads status only. It
  changes nothing. The rules below it apply only then.
  - A failing required check is a blocker.
  - Exit code 8 means a check is pending. The pending check goes in `Checks`, not
    into the blockers.
  - Exit code 1 covers a failing check, a repository with no required check, and
    a read error. A blocker is reported only when the output lists a failing
    required check. Any other exit 1 is unresolved and goes in `Checks`.
  - The command omits a check that has not started, so a read pass covers only
    the listed checks.
  - The read reflects the PR head on GitHub. When that head differs from the
    local reviewed head, the mismatch goes in `Checks`.
  - When `gh` cannot read the checks, for example no `gh` or no network, the
    status is unresolved and goes in `Checks`. A pass is reported only when the
    read shows one.

The `--require-ci` finish gate stays the enforcement point. The rule only lets
the reviewer see a failure before the gate refuses, so the run needs no extra
worker turn and no extra reviewer turn for that failure.

## The runtime supplies the required-check status

A reviewer turn that cannot reach the network, for example a sandboxed Codex
reviewer, could only report the status as unresolved before. A run that declares
its PR with `--pr <pr>` knows the pull request before the first turn, so the
runtime reads the required-check status for that PR head and supplies it to every
reviewer prompt. The prompt adds two lines inside the required-check group, so
they apply only under the pull request condition:

- This run read the required checks for PR <pr> before this turn: <summary>. That
  status is advisory evidence for this turn, in place of the read above: report
  it, and treat it as a report rather than a verdict. The `--require-ci` finish
  gate re-reads GitHub and enforces the condition.
- Your own read is the fallback. Read the required checks yourself when the
  supplied status is unresolved, or when the reviewed head is not the head the
  supplied status names. Report any difference between your read and the supplied
  status in `Checks`.

The runtime reads the status for that PR head and supplies it to every reviewer
prompt. That status is advisory evidence, in place of the reviewer reading the
checks: the reviewer reports it, keeps its own read as the fallback, and reads
the checks itself when the supplied status is unresolved. The `--require-ci`
finish gate re-reads GitHub and enforces the condition. The runtime reports the
status it read beside the reviewer result, so compare it with the reviewer Checks
line.

The reviewer's own read is never removed, and the head matters. A supplied status
is evidence for that turn, not a gate: `gh pr checks` lists only the checks that
already reported, so a supplied pass covers the listed checks only, and a failed
read is an unresolved status rather than a turn failure. The runtime reports the
status it read beside the reviewer result, in the dispatch envelope and in the
state file, so compare it with the reviewer Checks line and act on a
disagreement. A headless run renders the same status in the result prompt the
orchestrator receives after a reviewer turn, as `prChecks` beside the response and
the reviewed state, so the orchestrator holds the status and the reviewer Checks
line in one prompt. A turn that made no read carries no `prChecks` field.

The runtime reads the PR head first and compares it with the local reviewed head,
so a status is reported only for the head it describes. A read whose PR head
differs from the local head, and a read with no local head to compare, are
unresolved, and the prompt never reports a pass for a head the reviewer is not
looking at. Every supplied status states the head it describes.

The head and the checks are two separate reads, and the pull request can advance
between them. `gh pr checks` reports no commit and cannot be asked for one, so
the runtime reads the head again after the checks. A head that moved is
unresolved, because the checks belong to a commit other than the one the status
would name.

One window survives that re-read and is an accepted gap: a head that advances to
another commit and returns between the two head reads leaves both reads naming
the same commit while the checks describe the other one. No re-read separates
that, and `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` reports every
check run on a commit rather than the required ones, so it would have to rebuild
the required-name source from repository rulesets and classic protection. Every
supplied status therefore carries `advisory: true` and is a report, not a
verdict: the reviewer treats it as evidence, and the `--require-ci` finish gate
re-reads GitHub and refuses the finish on the real condition. A status never
replaces the gate.

The status comes from the exit code the rule above names: 0 is a pass, 8 is a
pending check, and 1 is a failing check, a pull request with no required check,
or a read error. Exit 1 reports a failing check only when the reply lists a
failing required check, the same evidence the rule requires before a blocker. A
reply that is not a well-formed list, and any other exit code, are unresolved.

A run that declares no PR reads no status, and the reviewer keeps its own read.
The read follows `--pr`, which is the PR input both paths know at dispatch. A
headless run that takes only `--require-ci` and declares no `--pr` reads no
status.

## Waiting for required checks

When a run will end with `--require-ci`, wait for the required checks on the new
PR head to complete before you dispatch the reviewer. When a reviewer turn
reports a pending required check in `Checks`, wait for those checks to complete
before you call `finish`.

The wait is the status read the role rule excepts, and it changes nothing. The
runtime owns the bound, because `gh pr checks --watch` takes no timeout and a
shell `timeout` exists on neither Windows nor macOS by default:

```bash
agent-loop role wait-checks --cwd <dir> --pr <n> --timeout <seconds>
```

The command returns inside its own bound, before the command timeout your harness
applies to a shell command, and prints one JSON envelope on stdout. `--cwd` must
be inside a Git work tree, as it is for `dispatch`, because the read runs there:

```json
{
  "status": "ok",
  "pr": 42,
  "timedOut": false,
  "checks": [{ "name": "ci", "state": "SUCCESS", "bucket": "pass" }]
}
```

`--timeout` is in seconds and defaults to 300. Set it below the command timeout
your harness applies when that timeout is smaller. `--timeout 0` is refused.

The bound starts at command entry, so no step of the command adds time to it.
Work-tree validation runs inside the bound, so a slow or hung `git` cannot push
the command past it; a validation that reaches the bound refuses, because a work
tree the probe never confirmed is not one this command may read. Every read is
limited to the time the command has left, and a read that reaches the limit is
stopped and then given five seconds to exit. The total bound of the command is
`--timeout` plus those five seconds, so set `--timeout` at least five seconds
below your harness command timeout. A wait that ends on the bound reports
`timedOut: true` with the last check states it read. It is a completed read, not
a read failure. An empty `checks` with `timedOut: true` means no check state was
ever read, so it never reads as a pass.

`childExitUnconfirmed: true` appears only when those five seconds expired with the
`gh` child still unaccounted for. The command does not claim an exit it did not
observe, so a `gh` process from an earlier wait may still be running; a parent
that sees it should settle the outstanding `gh` process before starting another
wait.

The `gh pr checks` exit codes decide the outcome, as the reviewer read states:
exit 0 with no pending check listed is settled, exit 8 is pending, and exit 1 is
settled only when the output lists a failing required check. Any other exit 1,
and any output that is not a check list, is unresolved: the command exits 1 with
`status: "error"` and records no check state for that wait, so an unresolved
read never reads as a pass. Every check item is read as a name plus a `state` or
a `bucket` the CLI knows; an item that carries no readable state is unresolved
too, so one item the CLI cannot read cannot settle the wait as a pass. Never
record a check you could not read as passed.

A `bucket` of `pending` marks a pending check, and `fail` or `cancel` marks a
failed one. A check that has not started is absent from `checks`, because the
command omits it, so an empty list means no required check has reported yet and
the wait continues.

A required check still pending after a wait, whether it failed or the bound
elapsed, is not a finish condition. The `--require-ci` gate refuses a finish
while a required check is pending, so a finish summary cannot carry it. Wait
again, dispatch the reviewer again, or `abort` with the pending check named in
the reason.

## Waiting in the headless loop

The orchestrator CLI and the reviewer CLI are chosen independently, so each
statement below names the role whose CLI performs the read. A read-only
invocation keeps shell network access for `claude`, `agy`, `opencode`, and
`copilot`. The `codex` read-only sandbox blocks network, and it is the only
adapter that does; see "Codex read-only network limit" in the README for the
probe.

- Orchestrator CLI keeps network: the orchestrator waits, at both points below.
- Orchestrator CLI blocks network, reviewer CLI keeps it: the orchestrator cannot
  wait. Every reviewer turn reads the required checks, as the reviewer scope
  states, so name the required checks in the reviewer prompt and let the reviewer
  turn read them. Each further reviewer dispatch costs a step, so the step budget
  has to cover those dispatches.
- Both CLIs block network: no turn in the run can read the required checks, so
  the headless loop cannot wait. A run that declares its PR with `--pr <pr>` still
  supplies the status to each reviewer turn, because the runtime reads it outside
  every read-only turn, so the reviewer does not have to. A run that declares no
  PR gets no supplied status, because the runtime reads one only for `--pr`. That
  supplied status is advisory: it reports to the reviewer and never enforces.
- The `--require-ci` finish gate is the only check read here that enforces; a declared PR's advisory status read does not. The gate refuses a
  finish while a required check is pending. A refusal itself charges no step, and
  the reviewer dispatch that corrects it charges one, so the step budget has to
  cover those dispatches. Dispatch the reviewer when the gate refuses, or `abort`
  with the pending check named in the reason.

A headless status read spends no step, because a step is charged only to
`run_worker` and `run_reviewer`. It is not free of other cost. The turn is
bounded by the per-invocation `--timeout`, which defaults to 3600 seconds and is
unbounded at 0, and a turn that outlasts that bound ends the run on exit 1
before it returns an action, so a long watch can end a run that would otherwise
have finished. Bound the watch to a few minutes so it returns inside the turn.

On an orchestrator CLI that can run the status read, both wait points hold in the
headless loop: the wait before the reviewer dispatch, and the wait before
`finish` when a reviewer turn reported a pending check. A check still pending
after a wait is not a finish condition there either, because the gate refuses
the finish. Wait again, dispatch the reviewer again, or `abort` with the pending
check named in the reason.

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

## Loop policy

- `work-first`: worker, reviewer, worker corrections, reviewer, until
  `verdict: accept`.
- `review-first`: reviewer first, then worker corrections and another review
  if needed.
- `review-only`: reviewer, then report. Findings alone never authorize edits;
  the subcommand rejects worker dispatch in this mode.

This section governs the interactive `role` mode. The headless loop chooses its
own action order; its prompt states the completion rule and the `review-only`
mapping instead, and `agent-loop --require-accept` enforces that rule. The
headless gate follows turn order only; an edit made outside the loop after a
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

## Completion

Completion is completion of the requested work, not code acceptance.

- `work-first` and `review-first`: call `finish` after the reviewer returns
  `verdict: accept` on the latest changed state and the report names the
  checks that passed.
- `review-only`: call `finish` after the reviewer report, whatever the
  verdict. The summary records the verdict in `verified` and the findings in
  `open`.

Map the child report fields into the finish summary:

- Carry each `Deferred` item forward from every worker or reviewer turn. An item
  leaves the list when a later worker turn reports it done and a later reviewer
  `accept` covers that state; record it in `changed`. The items that remain at
  `finish` go into `deferred`.
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
`summary` keeps exactly those five. The envelope then carries
`"unresolvedCompare": true` and the state file records the same field beside
`summary`, so a recorded unresolved compare never reads the same as a verified
finish, which keeps the current envelope and state (#281). A finish with the
field absent, or set to `false`, is a verified finish. The marker cannot be
combined with `--require-ci`: that gate resolves the PR head itself, so a
compare it verified is not unresolved. A run that cannot use `--require-ci`,
for example one whose base branch requires a check this credential cannot read,
records the marker. A base branch whose required-check sources each state that it
holds no required check can use the gate, which verifies the PR head, the clean
reviewed tree, and the merge state.

Without the gate, the runtime never resolves the PR head, so it cannot tell an
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
  broke, so read all of it rather than the first reason. A matching gate applies
  its own conditions on top of the declaration, and a gate for another PR is never
  read.
- The gate flag is a run input, so no `dispatch` supplies it and a repeat
  `finish` is refused the same way. A declared run with no gate can only end
  through `abort` with the missing gate named in the reason.
- `--pr` is an init field, so a later call that changes it is refused like any
  other init field. A state file written before this field has no `pr`, and that
  run keeps the marker-only behavior.
- `review-only` refuses `--pr` at init, because that mode rejects `--require-ci`
  at finish and the run would refuse every finish.
- A base branch with no required check does not refuse `--pr` when every
  required-check source stated that it holds none. The gate passes on the PR head,
  the clean reviewed tree, and the merge state, and the run records it, so a
  declared run on such a branch ends and never keeps the #286 gap. A base branch
  whose required checks this credential cannot read still refuses every finish,
  because the gate cannot establish the absence, and the refusal names the source
  it could not read.

A run that declares no PR keeps the accepted gap: the runtime has no PR input, so
an omitted marker still reads as a verified finish. The declaration closes the
gap for a run that states its PR (issue #302).

A marked `role finish` still exits `0`, unlike the headless finish that exits
`4` for the same marker. The exit code is not the outcome channel of this
subcommand: `abort` exits `0` too, and the parent guard reads the state
lifecycle, not the code. Read the marker in the envelope or the state file.

Two opt-in gates apply to `work-first` and `review-first` only. One refusal
names every condition the finish breaks, in the order the marker condition, then
`--require-accept`, then the declared-PR gate condition, then `--require-ci`. The
headless loop grants one corrective turn, so a refusal that named a single
condition would spend it on the condition the next refusal names instead. The
`role finish` command applies the same rule and order, so a parent learns every
condition from one call. A headless run ends when two refusals land with no child
turn between them. The marker is satisfied on a re-finish, with no child
turn; every other condition needs a child turn to satisfy it, which costs a step,
except the missing gate of a declared PR run, which no child turn can supply.
The `--require-ci` gate runs only when nothing above it refused, so a refused
`finish` never reads GitHub. In `review-only`, a `finish` without them keeps the
current behavior, and each flag fails with a clear error.

- `--require-accept`: refuse unless the latest turn is a reviewer accept with a
  `Checks` line, the reviewed snapshot is exact, and the current snapshot is
  exact with the same `head` and `digest`. The `head` and `digest` comparison
  detects a change to an uncommitted state at the same commit.
- `--require-ci <pr>`: refuse unless the PR head equals the reviewed `head`, the
  reviewed tree is clean, the PR is not behind its base under a strict rule, has no
  merge conflicts, the merge state is one the gate can read and is not blocked, and
  every required check passed on the commit GitHub evaluates. A base branch whose
  required-check sources each state that it holds no required check has no check to
  wait for: the gate then passes on the PR head, the clean reviewed tree, and the
  merge state, and records that no required check exists, in a
  `no-required-checks` event in a headless run and in `noRequiredChecks` in the
  envelope and the state file here. The event appears on an accepted finish only, so
  a refused finish never reports an absence.
  The rule for that pass is one allowlist, and it fails closed. Each required-check
  configuration source is classified by what its reply proved. An unknown ruleset
  read refuses the finish whatever the rest of the union holds, before the per-check
  pass, because that reply may carry a required-status rule the gate never saw.
  Otherwise a finish passes on the absence only when no source named a required
  check and no source is unknown, so both sources must have stated the outcome, and
  an unknown classic-protection source keeps the empty-union refusal with the reason
  naming it, so a parent can fix a source it can name. An exact list of every reply
  shape and its class is in
  `adr/0012-establish-the-absence-of-a-required-check.md`; the three classes are
  absent, has-contexts, and unknown.
  Absent, the only class that lets a finish pass, has exactly one reply per source.
  For repository rulesets it is a read of every page that returns a non-empty array
  whose entries all carry a documented rule type and none is a
  `required_status_checks` rule, which is the read of a branch that has no
  required-status-check rule; the read is paginated, so a rule on a later page is
  enforced rather than missed, and a body the gate cannot account for every page of
  is unknown. For classic branch protection it is exactly
  `gh: Branch not protected (HTTP 404)`, one trailing line break aside, which the
  endpoint writes only to a caller that can read protection. No successful
  classic-protection body proves an absence, because a classic-protected branch can
  require reviews without requiring a check, so a readable body that names no check
  is unknown. Has-contexts is a reply that named at least one required check, so the
  per-check pass runs and enforces it. Unknown is every other reply, including an
  empty ruleset result, a ruleset entry whose type is missing or is not a documented
  rule type, a malformed or unparseable body, and every unreadable reply.
  A branch reaches the absence path where both sources state the outcome, so a
  ruleset-only branch does, while a branch with no ruleset at all does not, because
  an empty result, and an empty page inside a longer read, state nothing, and neither does a
  classic-protected branch that
  requires reviews but names no check. GitHub documents that the ruleset read
  returns active rules only, so a rule in a ruleset whose enforcement is `disabled`
  or `evaluate` never appears in it and never affects the classification.
  `gh pr checks --required` is never classified and never establishes the absence. It
  lists only the checks that already reported, so it can name a required check and
  it cannot prove one is absent, and on a base branch with no required check it
  prints nothing, which is the same silence as a read failure. The gate takes
  required names from its stdout whatever the exit status, so a non-zero exit whose
  stdout holds that JSON still contributes names, and only a stdout that is not a
  JSON array of named checks contributes none. Its reply on a Free-plan repository
  was not measured.
  The observed replies for the two configuration sources are `Not Found` (404) for a
  token without repository admin, `Branch not protected` (404) for an admin on a
  branch with no classic protection,
  `Resource not accessible by integration` (403) for a `GITHUB_TOKEN`, and
  `Resource not accessible by personal access token` (403) for a fine-grained PAT
  without the Administration permission. A rate-limit or SSO 403 fails the run by
  design, because it matches no unreadable shape and is not read as a source at all.
  The exception to ruleset readability is a private repository on the GitHub Free
  plan, where the plan does not allow the rule at all. The Free-plan 403, `Upgrade
to GitHub Pro or make this repository public to enable this feature.`, was measured
  on the classic protection, branch rules, and rulesets endpoints with an admin
  classic PAT and an admin fine-grained PAT, and a read-capable collaborator was not
  tested, so whether a non-admin sees the same 403 is unverified. A private GitHub
  Free-plan repository still refuses a declared run under this change, so this does
  not resolve #336 for it, and such a repository must omit `--pr`, which leaves the
  #286 gap in place.
  Repository rulesets are readable with read access on a repository whose plan allows
  the rule, so a token without repository admin still gates through repository rulesets
  and through `gh pr checks --required` while the classic-protection source stays
  unknown. A required check that never started cannot escape the gate: the per-check
  pass refuses it when a source names it, and the blocked-merge-state refusal covers
  it when no source names it. The gate cannot tell a missing check from an unmet
  review or another required rule, so a repository with required approvals also
  refuses until they are met, and a branch that states it has no required check still
  refuses while its merge state is blocked. GitHub computes the merge state lazily,
  so a retry shortly after a push can clear an `unknown` state. This gate needs the
  `gh` CLI.

## Blockers and terminal states

- Blocker, `interrupted` lifecycle, or step limit with work remaining: call
  `agent-loop role abort --cwd "<work tree>" --reason "<explanation>"` and
  report the unresolved condition. Never repeat an uncertain turn without a
  maintainer decision.
- `halted` lifecycle (reviewer mutation or snapshot error): the run is already
  terminal and the subcommand rejects further operations, including `abort`.
  Report the failure and the modified paths from the envelope, then stop.
- Every run ends in exactly one terminal lifecycle: `finished`, `aborted`, or
  `halted`. The parent-edit guard (#57, Claude Code, Codex CLI, Copilot CLI,
  OpenCode, and Antigravity CLI) releases on any of them. Every `agent-loop role`
  init requires `--parent-session`, so the guard always has a parent to match.
  The headless `agent-loop` command is the explicit unguarded path.

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

## Turn history

Every `agent-loop role` run keeps its own turn history. No `--transcript` flag is
needed: the subcommand records each dispatched turn itself.

- The state file's `turns` array holds one entry per charged step, in order, and
  each entry survives every later dispatch that overwrites `lastDispatch` and
  `lastResult`.
- Each entry holds `role`, `status`, `verdict`, `head`, and `at`: the role that
  ran, the turn `status`, the reviewer verdict for a reviewer turn (`null`
  otherwise), the head the reviewer turn reviewed (`null` otherwise), and the
  turn time. Report and response text stay out of the entries.
- `status` is `ok`, `error`, or `interrupted`. An `interrupted` entry is a turn
  whose step was charged but whose outcome is unknown: no child result was ever
  recorded for it, so its verdict and head are `null`. The call that marks the
  run `interrupted` records it, so the history stays complete across recovery.
- Size bound: exactly one entry per charged step, and a dispatch past `maxSteps`
  is refused before it runs, so `turns` holds at most `maxSteps` entries. The
  recovery call records an already-charged step and charges none of its own, so
  it does not push the history past that bound. The entries are fixed-shape, so
  the history cannot grow with the text a child returns.
- Accepted `--max-steps` range: 1 to 9007199254740991 (`Number.MAX_SAFE_INTEGER`).
  The CLI refuses a `--max-steps` outside it, and `dispatch` and `finish`
  re-check the stored `maxSteps` against the same range before reading the
  budget, because a state file written by an earlier version or hand-edited
  carries the value past the flag check. A refusal names the state file field to
  correct. Every budget a run reads is therefore a safe integer, so the step
  count always advances by exactly one per charged step.
- `abort` is not subject to that check. It charges no step and reads no budget,
  so it proceeds and ends the run. Use it to close a run whose stored `maxSteps`
  is out of range: `dispatch` and `finish` are refused, and a new init refuses
  over a non-terminal run, so `abort` is the only route to a terminal lifecycle
  for such a run. A new init then starts normally and archives the old state
  file. No field has to be hand-corrected.
- Read `turns` after compaction or restart to rebuild which turns ran, which
  verdicts they returned, and which head each reviewer turn saw.
- `--transcript <file>` still appends one JSON line per `invocation` and
  `result` event. It stays a per-call flag and is not the turn history.
