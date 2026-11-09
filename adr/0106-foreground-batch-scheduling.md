# 0106. Run several issue loops in one foreground batch

## Status

partially-superseded

## Superseded by

[adr/0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md) partially supersedes this ADR. The replaced parts are decision 16's entry that reviewer audit coordination and consolidated issue creation are deferred to milestone 2, and the Context sentence that lists reviewer audit coordination as out of scope. Decisions 1 to 15 stay in force, and milestone 1 stays standalone.

[adr/0110-release-batch-slots-on-owner-decisions.md](0110-release-batch-slots-on-owner-decisions.md) partially supersedes this ADR. These parts are replaced:

- Decision 1's return rule. The command also returns with status `waiting` for a pending decision.
- Decision 5's sentence that a `needs-owner` loop keeps its slot.
- Decision 6's `blocked` skip, which becomes a waiting poll.
- Decision 16's in-batch decision request, slot release, owner-merge continuation, and desktop
  notifications.
- The consequence and the milestone 1 standalone sentence that a `needs-owner` loop holds one
  slot.

[adr/0114-report-an-exit-4-loop-as-needs-owner.md](0114-report-an-exit-4-loop-as-needs-owner.md) partially supersedes this ADR. The replaced parts are the exit 4 rule of decision 10's sentence "A loop that ended 1, 2, or 4 is `failed`". They also include the exit 4 part of decision 12's sentence that a loop ending on a nonzero headless exit is `failed`. They also include the `closed-by-open-pr` rule of decision 6, for a live `resume` answer that ignores an open pull request that the loop itself recorded.

[adr/0115-batch-loop-final-report.md](0115-batch-loop-final-report.md) partially supersedes this ADR. The replaced part is decision 1's summary field list. The other sentences of decision 1 stay in force.

[adr/0119-start-a-batch-from-the-frozen-issue-set-of-a-finished-audit.md](0119-start-a-batch-from-the-frozen-issue-set-of-a-finished-audit.md) partially supersedes this ADR. The replaced parts are decision 2's rule that `--issue` is the only issue source and decision 3's rule that the runtime selects no issue and receives its numbers only from the skill. An explicit `--from-audit <id>` reads the frozen set of a finished audit; the runtime still reads no label, milestone, project, or request. Every other sentence of decisions 2 and 3 stays in force.

Every other decision, consequence, and acceptance check stays in force. The batch still never
merges, approves, comments on, labels, force-pushes, resets, or deletes a branch.

## Supersedes

This ADR partially supersedes
[ADR 0014: Extend the step budget of a live interactive run](0014-extend-the-step-budget-of-a-live-run.md).
The replaced part is its consequence that the headless loop is unchanged and that its
`--max-steps` stays fixed for the invocation. An invocation still starts its own count at 0,
but the budget of a batch loop spans attempts and a continued attempt spends the remainder,
so the fixed number of one invocation is a slice of one loop budget.

Decisions 1 to 4 and 6 to 8 of ADR 0014 stay in force. Decision 5 is partially superseded by
ADR 0084. The `extend` command, its range and lifecycle checks, and its parent-session guard
stay in force. The `budgetChanges` shape, the live harness check, and every other consequence
stay in force. The child guard and its rule that only the
owner authorizes more steps stay in force. A batch recovery spends only the budget that
`batch start` recorded; it never raises it.

[ADR 0026](0026-detect-a-changed-resolved-model-on-continue-from.md) stays the headless
continuation contract. This ADR composes it and does not replace its session, gate, model,
or refusal rules.

## Date

2026-11-08

## Context

A batch of issues runs today one session at a time through the interactive parent. The
parent selects issues, creates one work tree, drives one `role` run to a terminal
lifecycle, and then starts the next. Nothing records the set, nothing survives the loss of
the parent session, and two batch commands can select the same issue.

The selection reads already exist. [Issue #1486](https://github.com/andromarces/agent-loops/issues/1486)
and [issue #1560](https://github.com/andromarces/agent-loops/issues/1560) define the read of
the issues that an open pull request closes, and
[docs/orchestrator-instructions.md](../docs/orchestrator-instructions.md#selecting-issues-for-a-batch)
states it. The headless `agent-loop` command already runs one task to a finish with its own
sessions, transcript, review gate, and required-check gate. The machine-wide test slot
already bounds full suites, with a default count of 1
([ADR 0046](0046-default-the-test-slot-count-to-one.md)).

The missing decision is the scheduler around those pieces: explicit settings, one headless
run per issue, concurrent foreground loops, eligibility, local claims, checkpoints,
recovery with the remaining step budget, GitHub reconciliation, failure isolation, and
cleanup of what the batch created.

The entry-point skill is the only natural-language reader. It interprets a request such as
"work these issues with codex and claude, three at a time" and passes explicit values to
the runtime. The runtime validates those values and never reads a request, infers a
setting, or prompts an operator.

Three later capabilities are out of scope and must not be required for this milestone:
reviewer audit coordination (milestone 2, issue #1710), decision handling with slot release
and owner-merge continuation (milestone 3, issue #1711), and desktop notifications
(milestone 3).

## Decision

### 1. One foreground command owns a batch

`agent-loop batch start` owns the batch for its whole life. It runs in the foreground,
launches the loops, prints progress, and returns only when every selected issue is
terminal or the batch is interrupted. There is no daemon, no detached supervisor, no
scheduler service, and no process that outlives the command on a normal exit.

The command family is:

- `agent-loop batch start ...` starts a new batch and prints its id before the first launch.
- `agent-loop batch status [--batch <id>]` reads a batch and writes nothing. With no id it
  lists the local batches, newest first.
- `agent-loop batch resume --batch <id>` continues an interrupted batch in a fresh session.

`start` and `resume` print progress lines on stderr and one JSON summary object on stdout
at the end. The summary carries the batch id, status, and one entry per selected issue with
its loop status, reason, work tree, branch, pull request, attempts, steps used, remaining
steps, log, transcript, and cleanup result.

The exit code is 0 when every selected issue ended `succeeded` or `skipped`, 1 when any
loop ended `failed` or `needs-owner` or the queue paused, 2 for a refused setting or a
refusal before any state write, and 130 when SIGINT ended the batch.

### 2. The skill resolves the request; the runtime validates it

The installed entry-point skill selects the repository, issue numbers, agents, models,
efforts, step limit, loop concurrency, base branch, work-tree root, task template, setup
command, test command, timeout, and reviewer sandbox. It passes every value as a flag. It
shows the resolved settings and the selected issue numbers before it starts the batch.

`agent-loop batch start` requires:

- `--repo <dir>`, the main work tree of the target repository. A linked work tree is
  refused, and the refusal names the main work tree.
- `--issue <n>`, repeated at least once. The order is the launch order. A duplicate number
  is a usage error.
- `--orchestrator <cli>`, `--worker <cli>`, and `--reviewer <cli>`.
- `--loops <n>`, an integer from 1 to 64.
- `--max-steps <n>`.

It accepts `--base <branch>`, `--work-tree-root <dir>`, `--task-template <text>`,
`--setup-cmd <command>`, `--setup-timeout <seconds>`, `--test-cmd <command>`,
`--test-cmd-timeout <seconds>`, `--timeout <seconds>`, `--reviewer-sandbox <mode>`, and the
`--<role>-model` and `--<role>-effort` flags of the headless command. `--base` defaults to
the remote default branch and is refused when `origin/<base>` does not exist. The remaining
flags keep the headless defaults when omitted, and every supplied value is validated by the
same parser the headless command uses.

The task template accepts `{issue}`, `{title}`, `{branch}`, and `{repo}`. An unknown
placeholder, or a template with no `{issue}`, is a usage error. The default template names
the issue, tells the worker to read the issue body, commit on the branch, push with
`git push -u origin <branch>`, and open a pull request that closes the issue.

No turn and no child supplies a setting. A refusal happens before a claim, work tree,
checkpoint, or child process exists.

### 3. The selected set is explicit and frozen

The runtime selects no issue. It never reads a label, milestone, project, or natural
language request to choose one. The issue numbers come from the skill, which may apply any
selection rule the user states, including the open-PR exclusion of
[docs/orchestrator-instructions.md](../docs/orchestrator-instructions.md#selecting-issues-for-a-batch).

The selected set is written once at `start` and never grows. The eligibility refresh may
skip an issue, but it never adds one. A later resume reads the same set.

### 4. One headless run per issue in its own work tree

For each issue, the batch creates a linked work tree from the remote default branch, or
from `--base`, with a deterministic branch:

```bash
git worktree add --no-track -b "batch/<batch id>/<issue>" "<work tree>" "origin/<base>"
```

The default work-tree root is a sibling of the main work tree,
`<repo parent>/<repo name>-batch-<batch id>`, and each loop gets `<root>/issue-<n>`. The
root is created when missing and refused when it lies inside any Git work tree or is not a
directory the batch can write. The batch records the path, the canonical path, the branch,
and the directory device and inode after creation.

Before the first launch, the batch runs `--setup-cmd` once in the new work tree, through
the platform shell, within `--setup-timeout`. The command installs the dependencies that
the repository documents, because the headless run copies the ignored local files of the
main work tree ([ADR 0018](0018-copy-local-files-into-a-linked-run-work-tree.md)) but never
installs them. A failed setup marks the loop `failed` with reason `setup-failed`, and no
headless run starts.

Each loop is one child process of the batch, spawned with no shell option as
`node <installed cli> ...` with the per-issue arguments. A shell shim such as `pnpm` is not
used, which keeps the argument vector contract of
[ADR 0104](0104-accept-a-test-slot-command-as-an-argument-vector.md). The child runs with
`--cwd "<work tree>"`, the rendered task, `--max-steps`, `--transcript`, `--require-accept`,
the selected agent settings, and the optional `--test-cmd`, `--timeout`, and
`--reviewer-sandbox`. Its stdout and stderr go to `<batch>/logs/issue-<n>.<attempt>.log`.

The batch does not pass `--pr` or `--require-ci` on a first launch. The headless runtime
declares the pull request that the worker opens and gates the finish on it, as
[ADR 0043](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md) and
[ADR 0045](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md) state. The
batch never approves, merges, comments on, or labels a pull request. A review accept and
the required checks remain the completion decision.

### 5. Loop slots are separate from the test slot

`--loops` is a per-batch, in-memory limit on live headless runs. A free slot is filled
automatically from the frozen set, in order, until the set is exhausted or no candidate is
eligible. A loop holds its slot from launch until it reaches a terminal status or the batch
stops for an interruption. A `needs-owner` loop is not terminal in milestone 1, so it keeps
its slot until the owner resolves the state; milestone 3 adds the release.

The machine-wide test slot is unchanged. Every `--test-cmd` run of a loop goes through the
runtime and therefore through the test slot, whose default count is 1
([ADR 0039](0039-machine-wide-test-slot.md),
[ADR 0046](0046-default-the-test-slot-count-to-one.md),
[ADR 0040](0040-run-the-test-command-in-a-test-slot.md)). Two loops can therefore run at
once while their full suites run one after the other. The batch adds no second full-suite
path and no loop-wide test lock.

The loop limit is not machine-wide. Two batches add their limits, and the test slot remains
the machine-wide bound on full suites. The owner starts one batch; a second batch is a
deliberate second command, and local claims still prevent duplicate issues.

### 6. Refresh eligibility before each launch

Before a candidate is launched, the batch reads its current state and applies these checks
in order. Each failure records one skip reason and names the evidence:

- `closed`: `gh issue view <n> --json state` does not return `OPEN`.
- `blocked`: `gh issue view <n> --json blockedBy` names at least one open issue. The skip
  names those numbers.
- `claimed`: the local claim store holds a live or unreleased claim for the repository and
  issue. The skip names the owning batch, and a claim of the current batch is not a skip.
- `closed-by-open-pr`: an open pull request closes the issue. The batch applies the reads of
  [docs/orchestrator-instructions.md](../docs/orchestrator-instructions.md#selecting-issues-for-a-batch):
  `gh pr list --state open --json number,closingIssuesReferences --limit 1000`, then the
  commit messages of each open pull request. A commit page of 250 entries is incomplete, so
  the batch stops launching and reports the pull request for the owner's decision.
- `not-specified`: the body has no `## Acceptance` heading with at least one list item, or
  has neither a `## Problem` nor a `## Scope` heading. This is a structural minimum only.
  Whether an issue is semantically clear enough is the skill's selection judgment; the
  runtime does not read intent.
- `eligibility-unverified`: a read failed, returned an unreadable value, or could not
  settle one check. The issue is not launched. A failure of a batch-wide read pauses the
  queue instead, leaves the unread issues `queued`, and resumes them on the next resume.

The refresh runs first, and the claim is acquired only after it passes, immediately before
the work tree and the launch. Two commands can both refresh an eligible issue; only one
claim wins, and the other records `claimed`. This closes the local race without claiming an
issue that the refresh skips. A remote race with a host that ignores the claims remains
possible, and the loop's worker meets any pull request that appeared; the batch does not
guess what happened.

The skip report is part of the summary and the checkpoint. It is never a silent drop.

### 7. Atomic local claims, with no GitHub label

A claim is a file per repository and issue under
`<runs root>/batches/claims/<repo key>/<issue>.json`. The repo key is the first 12 hex
characters of the SHA-256 of the canonical main work tree path, with the Windows drive
letter lowercased, as the run state key does. The file records the batch id, issue, repo
path, work tree, pid, process start stamp, and creation time. It is created atomically with
no overwrite, so a contender sees either no file or a complete record. A partial or
unparseable claim counts as held, and its liveness decides whether it is stale.

A claim exists from the launch until the loop is terminal. It is released on `succeeded`
after cleanup and on `failed`. It is kept while the loop is `interrupted` or `needs-owner`,
because work may still need to continue. Every release and every stale removal runs under
the existing lock and liveness rules of
[ADR 0020](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md).

A claim whose pid and start stamp no longer name a live process is stale, but it is not
taken over silently. `batch resume` of the owning batch re-checks the recorded owner and
continues. A different `batch start` reads the owning batch checkpoint: it may remove the
claim only when that loop is `failed`; a `succeeded` loop's claim is removed by its own
cleanup, which also removes the work tree. Otherwise it refuses the issue and names the
batch to resume. An abandoned batch therefore does not block an issue forever, and an
interrupted batch keeps its recovery path.

No claim, status, or ownership value is written to GitHub. The batch creates no label,
comment, issue edit, or pull request. This keeps the claim workable on the repository's
GitHub plan and avoids a remote write that the runtime cannot make atomic.

### 8. Checkpoints outside any repository, written only on a change

The batch store is `<runs root>/batches/<batch id>/`, where the runs root is
`<os tmpdir>/agent-loops/runs` unless `AGENT_LOOP_RUNS_ROOT` overrides it
([ADR 0049](0049-pin-the-machine-wide-roots-for-every-child-turn.md)). The claim directory
`claims/` is a sibling of the batch directories, and a status list skips it. The default
runs root lives under the OS temporary directory, so set `AGENT_LOOP_RUNS_ROOT` to a stable
path when a checkpoint must survive a reboot. The batch store holds:

- `batch.json`: the batch id, repo, created time, settings, base, work-tree root, selected
  issues in order, and current batch status.
- `loops/issue-<n>.json`: one checkpoint per issue. It holds the loop status, skip reason
  or failure reason, attempt count, branch, work-tree path and identity, transcript path,
  log path, pid and start stamp while running, cumulative steps used, remaining steps,
  declared or reconciled pull request, and cleanup result.
- `transcripts/issue-<n>.json`: the headless transcript of the loop, in the format of
  [ADR 0026](0026-detect-a-changed-resolved-model-on-continue-from.md). A continued attempt
  rewrites the same file and keeps the earlier events.
- `logs/issue-<n>.<attempt>.log`: the child output.

Every checkpoint write is atomic, through a temporary file in the same directory and a
rename. One batch lock serializes the read-modify-write of a checkpoint between two batch
commands.

A checkpoint is written only when a relevant state changes: at `start` for the manifest
and each queued loop, at a launch, at a skip, at a child exit, at a reconciliation result
that changes the loop, and at the final batch status. There is no heartbeat, no periodic
write, no write on a status read, and no write when a resume finds nothing to do. A run in
which every issue is skipped still records the skip outcomes, because those are the
results; it creates no claim, no work tree, no transcript, and no child.

A `running` loop whose recorded owner is dead is reported as `stale` by `batch status`,
which writes nothing and names `batch resume` as the next action.

The checkpoint is local and unsigned. It has the same trust as a headless transcript: a
reader that edits a well-formed record can misdirect a resume. The batch validates every
field it reads and refuses an unknown or malformed status; it never trusts a recorded path
without the live checks of decisions 11 and 13.

### 9. Interruption is foreground and leaves a recoverable record

The first SIGINT stops new launches. The batch forwards SIGINT to each live child loop and
waits up to 30 seconds for each child to exit, so each headless run writes its transcript
and records its exit code. A child still live at that bound has its process tree ended, as
the runtime ends the tree of its own child ([ADR 0028](0028-end-the-windows-process-tree-when-the-runtime-exits.md),
[ADR 0033](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)). The batch then
writes every loop checkpoint, marks a loop that did not end as `interrupted`, marks the batch
`interrupted`, keeps every work tree and every claim, and exits 130.

A second SIGINT ends the batch without waiting, with the same exit code. A child tree may
then survive, and a checkpoint may lag. A hard kill (SIGKILL, a closed terminal, a lost
host) runs no handler. In both cases the next `batch resume` checks process ownership before
it does anything else. The batch never claims that an unrecorded turn did or did not run.

### 10. Recovery in a fresh session keeps the remaining step budget

`batch resume --batch <id>` reads the manifest and checkpoints, takes the batch lock, and
for each non-terminal loop:

1. **Checks process ownership first.** A checkpoint with a pid and start stamp that still
   name a live process is not restarted. The resume waits for that process to end, reading
   its liveness and not its output, then reconciles it from the transcript it wrote. It never
   signals a process that it did not start. A process identity that cannot be read is
   `needs-owner`; no second process starts.
2. **Establishes the steps used.** It reads the loop transcript and splits it into segments
   at each `continued` event. The highest `result` event's `stepsUsed` in a segment is that
   attempt's count. A trailing `run_worker` or `run_reviewer` action with no result in the
   last segment counts one more, because the runtime charges a step before the child starts.
   The total is the sum of the segment counts. The checkpoint's cumulative count is a
   cross-check, and the larger of the two is used, so a stale checkpoint cannot undercount. A
   transcript that cannot establish a count is `needs-owner` with reason `unverified-steps`;
   the batch does not guess a budget.
3. **Computes the remainder.** `remaining = maxSteps at start - steps used across every
   attempt`. A remainder of 0 marks the loop `failed` with reason `step-budget-exhausted`.
   A positive remainder is the `--max-steps` of the next attempt.
4. **Reconciles GitHub before any repeat** (decision 11).
5. **Continues the same transcript.** It starts one headless run with
   `--continue-from <transcript> --transcript <same path> --max-steps <remaining>` and the
   same agents, models, efforts, timeout, sandbox, and work tree. A resumed matching pull
   request is supplied as both `--pr <n>` and `--require-ci <n>`, because a run with `--pr`
   and no `--require-ci` refuses every finish (ADR 0045).
   [ADR 0026](0026-detect-a-changed-resolved-model-on-continue-from.md) still owns the
   session restore, the gate restore, and its refusals. A resumed attempt costs a new
   reviewer turn when the work tree no longer matches the last reviewed state, so a
   remainder of 1 may end at the step limit; the batch reports that reason and does not
   raise the budget.

A loop that reached exit 0 before the interruption is read as `succeeded`; it is not
restarted. A loop that ended 1, 2, or 4 is `failed` and gets no automatic retry. A loop
whose transcript ended a run with exit 130 but has remaining budget is resumed once, as
part of the recovery, because the interruption was the batch's own.

The configured `--max-steps` is the budget of the loop, not of one invocation. An invocation
still starts its own count at 0 and its own prompt states its own `--max-steps`, but the
batch composes attempts so that the sum cannot exceed the configured budget.

### 11. Reconcile an uncertain GitHub write before any repeat

Before a resumed attempt, and before any launch that follows an uncertain exit, the batch
reads the loop's local and remote state:

- `git -C "<work tree>" rev-parse HEAD` and `git status --porcelain`.
- The remote branch `refs/remotes/origin/<branch>` after a fetch of that branch.
- `gh pr list --head <branch> --state all --json number,state,headRefOid,isCrossRepository,baseRefName`.
- `gh pr view <n> --json state,headRefOid,mergeCommit` for each pull request that the list
  names for the branch.
- `gh issue view <n> --json state,closedByPullRequestsReferences`.

The batch then applies these rules:

- **Work tree missing, not the recorded directory, or on another checked-out branch:**
  `needs-owner`. It is not recreated, and no branch is checked out over it.
- **Issue closed and a pull request of this branch is merged, and the local branch has no
  commit that the pull request head lacks:** `succeeded`. The work was delivered, whatever
  the interrupted run's last exit code. It becomes eligible for cleanup.
- **Issue closed and the local branch holds a commit that the merged pull request head
  lacks:** `needs-owner` with reason `unpushed-local-work`. The new work is not in the
  merged pull request, so the loop is not successful and its work tree is kept.
- **Issue closed, and no pull request of this branch is merged:** `needs-owner`. The batch
  does not treat a manual close or another branch's pull request as this loop's delivery.
- **A pull request of this branch is closed without a merge:** `needs-owner`. The batch
  never reopens it or opens a replacement on its own.
- **One open pull request for the branch, its head equals the local head and the remote
  head, and the work tree is clean:** resume. The attempt passes `--pr <n> --require-ci <n>`,
  so the run must end through that pull request's required-check gate.
- **One open pull request for the branch with another head, more than one open pull
  request, a remote head that differs from the local head, or a diverged branch:**
  `needs-owner`. The batch never force-pushes, resets, merges, or deletes a branch to make
  the state fit.
- **A remote branch equal to the local head and no pull request:** resume without `--pr`.
  The worker may still open the pull request. Equal local and remote heads are not an
  ambiguous write.
- **A local branch ahead of its remote branch with no pull request:** resume. The commits
  are local and unpushed, not an uncertain remote write.
- **A read failure, an unreadable value, a transcript that declares a pull request that the
  read does not find, or a pull request of another branch that closes the issue:**
  `needs-owner` with the failing read named.

`needs-owner` is not a failure and gets no automatic retry. The loop keeps its claim, work
tree, and slot, and the summary names the exact read and the conflict. The owner resolves
the remote or local state, then runs `batch resume` again; the batch re-reads and continues
only when the state is no longer ambiguous. Milestone 3 adds the in-batch decision request
and the slot release; milestone 1 deliberately stops rather than guess.

### 12. Failure isolation

A loop that ends on a nonzero headless exit, a failed setup, a refused finish, or a child
error is `failed` with its reason. It gets no automatic retry, and its failure does not
stop any other loop or the queue. The batch keeps launching eligible issues into the
remaining slots.

A failed loop releases its claim, because it is terminal and no automatic work remains. It
keeps its work tree, branch, transcript, and log for inspection. A later batch may start the
issue again; it uses a new batch id, so its branch and work tree do not collide with the
failed ones.

A loop that ends `needs-owner` is not failed and is not retried. A loop that ends
`interrupted` is not failed and is resumed by `batch resume`.

The review gate and the required-check gate of the headless run are unchanged. The batch
does not accept a reviewer verdict, read a check status to override a gate, or mark a
pull request complete. A finish is successful only when the headless run records exit 0.

### 13. Cleanup removes only a pushed success

The batch removes a work tree only when its loop is `succeeded` and every one of these
checks passes:

- The path equals the recorded work-tree path, lies under the batch work-tree root, is not
  the main work tree, is a linked work tree that `git worktree list --porcelain` names for
  this repository, and has the recorded branch checked out.
- The directory still has the recorded device and inode, so a replacement path is never
  removed. An identity that does not match, or that the platform cannot report, keeps the
  tree and reports it.
- The work tree is clean, and every local commit is proved pushed. When the remote branch
  exists after a fetch, the local branch head equals or is an ancestor of
  `refs/remotes/origin/<branch>`, and `git rev-list --count origin/<branch>..<branch>` is 0,
  so no commit exists that the remote branch lacks. When the pull request is merged, the
  local branch head equals or is an ancestor of the pull request head that `gh pr view`
  names, and the merge commit is reachable from `origin/<base>`; this proof holds when the
  remote branch was deleted after the merge. A local commit that neither proof covers keeps
  the tree and is reported as `unpushed-local-work`. A read that cannot settle the proof
  keeps the tree and reports why.
- No live process other than this batch holds the loop claim, and no live run lock names the
  work tree ([ADR 0073](0073-lock-the-work-tree-of-an-active-run.md)).

It then runs `git worktree remove --force "<work tree>"` and checks whether the directory
still exists. A remaining directory is removed only by the link-safe procedure that
[docs/orchestrator/work-tree-removal.md](../docs/orchestrator/work-tree-removal.md) states:
first prove that it holds only directories and links, then delete without following a link,
with the same identity check. A real file that remains stops the removal and is reported.
The batch never removes the main work tree or any work tree outside its own root.

A `failed`, `interrupted`, `needs-owner`, or live loop keeps its work tree. A `succeeded`
loop whose push, identity, or lock proof fails, or whose removal fails, also keeps its work
tree and reports why. When cleanup succeeds, the work tree and the claim are removed; the
local branch, pull request, transcript, log, and checkpoint are kept. The checkpoint
directory is the inspection record and is not deleted by the batch.

General system temporary directory cleanup stays out, as
[ADR 0095](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md) decides. The
batch never scans, lists, waits for, or deletes inherited temporary directory entries, turn
directories, or another process's files.

### 14. Documentation for milestone 1

The implementation adds:

- A `Batch runs` section to `docs/reference/usage.md`: the command surface and every
  setting, selection and the frozen set, eligibility and skip reasons, loop slots versus
  test slots, claim and checkpoint locations, loop statuses, the summary and exit codes,
  interruption, resume with the remaining budget, GitHub reconciliation, failure isolation,
  cleanup, and the accepted hard-kill limit.
- A batch paragraph to `docs/reference/architecture.md`, naming the foreground supervisor,
  the headless child, the local stores, and the unchanged per-loop gates.
- A batch rule in `docs/orchestrator-instructions.md`: the skill resolves the natural
  language request into explicit flags and runs `agent-loop batch start`; the parent does
  not dispatch one `role` turn per issue for a batch. The existing selection section stays
  the source of the open-PR exclusion.
- A note in `docs/reference/harness-entry-points.md` that the skill is the only
  natural-language reader and that the runtime prompts for nothing.
- The `agent-loop batch` lines in `help.mjs`, with the refusals and exit codes.

README and onboarding expansion stay out of scope.

### 15. Standalone acceptance checks for milestone 1

The implementation passes these checks without milestone 2 or 3:

1. **Settings.** A missing `--loops`, a loop count outside 1 to 64, an invalid
   `--max-steps`, an unknown agent, model, or effort, an empty selection, a duplicate
   issue, an unknown task placeholder, and a work-tree root inside a Git work tree each
   exit 2 before any claim, work tree, checkpoint, or child exists.
2. **One run per issue.** Three selected issues create three work trees, three branches,
   and at most `--loops` live headless children, each with `--cwd` in its own work tree and
   its own transcript.
3. **Eligibility.** Fixtures for a closed issue, a blocked issue, a locally claimed issue,
   an issue closed by an open pull request body, an issue closed by a pull request commit
   keyword, an issue with no acceptance section, and a failed read each produce the named
   skip reason and launch no child. A 250-commit page stops the queue.
4. **Frozen set.** An issue opened after `start` is not launched, and an issue removed from
   the set is not replaced.
5. **Claims.** Two batch commands for one repository and issue race for one claim; exactly
   one launches, and the other reports `claimed`. A skipped issue is never claimed, and a
   failed loop releases its claim.
6. **No-op writes.** A `status` read changes no checkpoint mtime. A resume with no pending
   work and a run whose every issue is skipped create no claim, work tree, transcript, or
   child; the skip results are the only new record.
7. **Write cadence.** A loop checkpoint changes on launch, skip, child exit, reconciliation,
   and terminal status, and not between those events. A file hash and mtime comparison over
   a quiet interval shows no write.
8. **Slots.** With `--loops 2` and three eligible issues, at most two children run; when one
   exits, the third starts. With `AGENT_LOOP_TEST_SLOTS=1`, two loops can run while their
   full suites serialize in the test slot.
9. **Interruption.** SIGINT stops new launches, forwards the signal, writes transcripts and
   checkpoints, marks each unfinished loop `interrupted`, keeps every work tree and claim,
   and exits 130. No child survives a normal interruption.
10. **Recovery.** A loop interrupted after 3 charged steps of a budget of 10 resumes with
    `--max-steps 7`; the two transcripts show a total of at most 10 charged steps and the
    same sessions. A live owner is never restarted. A transcript with an unreadable count is
    `needs-owner`, not a guessed budget.
11. **Reconciliation.** A matching branch and one open pull request resume with `--pr` and
    `--require-ci`. A different head, two open pull requests, a diverging branch, a
    closed-unmerged pull request, a missing work tree, and a failed read each stop the loop
    as `needs-owner` without a child. A merged pull request with no local commit beyond its
    head is `succeeded` and eligible for cleanup; one with extra local work is `needs-owner`.
12. **Failure isolation.** One loop at the step limit and one loop that finishes leave the
    finished loop successful; the exhausted loop is not retried and the batch exits 1.
13. **Cleanup.** A pushed successful work tree is removed after every identity and reachability
    check. An unpushed tree, a dirty tree, a failed tree, an interrupted tree, a
    `needs-owner` tree, a replaced directory, and a work tree with a live lock each stay,
    with the reason. The main work tree and every path outside the batch root are never
    touched.
14. **Platforms.** The claim atomicity and process identity check run on Windows, macOS, and
    Linux. The work-tree removal, including the Windows link and junction case, runs on
    Windows and macOS. Any target that a check cannot run is recorded in the matching
    shared verification checklist (#707, #708, #709, or #710), never in a new issue.

### 16. Deferred capabilities

Milestone 1 does not provide, and does not depend on:

- Reviewer audit coordination and consolidated issue creation (milestone 2, #1710).
- An in-batch decision request, a slot release while a loop waits for the owner, and an
  unambiguous answer bound to one decision (milestone 3, #1711). Milestone 1 stops the loop
  as `needs-owner`, holds its slot, and re-reads after the owner resolves the state.
- Automatic continuation after the owner merges a pull request (milestone 3, #1711). The
  owner runs `batch resume`.
- Desktop notifications on Windows and macOS (milestone 3, #1711).
- README and onboarding expansion.
- Combined validation merges.
- General system temporary directory cleanup.
- A machine-wide loop slot, automatic retry of a failed loop, automatic force-push, branch
  cleanup, or pull-request merge.

## Milestone 1 is standalone

One `agent-loop batch start` runs an explicit set of independent issues to success or a
reported stop, opens their pull requests, records every decision, resumes after an
interrupted session with the remaining budget, and removes only the work trees whose work
is pushed. A loop that needs an owner decision or a merge holds one slot and is reported;
the other loops and the queue continue, and the owner resolves it before the next
`batch resume`. Nothing in that flow needs audit coordination, an in-batch decision
protocol, owner-merge continuation, or a notification. Issue #1709 can therefore merge and
be used alone.

## Consequences

- A batch of independent issues runs concurrently, bounded by `--loops`, while full suites
  still serialize through the one test slot by default.
- The foreground command is the only supervisor. Closing its terminal stops the batch on a
  graceful signal; a hard kill leaves a record that the next session resumes.
- A checkpoint is written per event, not per tick, so a quiet loop adds no disk writes. The
  price is that a hard kill can lose the last event, and the batch then refuses to guess the
  step count or the remote state.
- Claims are local and advisory. A host that ignores them can still start the same issue,
  and the issue's open pull request or the branch state is the remaining protection.
- A `needs-owner` loop holds a slot until milestone 3 or until the owner resolves it, so a
  large batch can stall with a slot occupied. The other slots and the queue stay live.
- A failed loop keeps its work tree and branch. Disk use grows with each failure and each
  unreviewed success; the owner decides when to remove them. A successful loop's work tree
  is removed only after the push is proved.
- The batch adds no remote state, so its claims, slots, and status are invisible to a second
  host. The existing pull-request declaration and required-check gate still decide
  completion, and a merged pull request is external evidence that its head landed.
- The step accounting composes attempts. A loop's budget is spent once, even across a
  resumed session, and the per-invocation prompt reports only that attempt's slice.
- The accepted hard-kill limit: a transcript that never recorded a step count cannot prove
  the remainder, so the loop is `needs-owner` instead of resumed. A per-step transcript write
  would close it and is rejected (alternative 10).
- The local checkpoint and claim are unsigned. A well-formed edit can misdirect a resume, as
  a well-formed transcript edit can (ADR 0026). The live path, identity, work tree, and
  remote checks fail closed on every mismatch.

## Alternatives

1. **A GitHub label as the claim.** Rejected. The repository forbids creating labels without
   authorization, a label write is remote and non-atomic, and a second host would see it
   only after a read that can fail. A local exclusive-create file is atomic, testable, and
   works on every supported platform.
2. **A detached supervisor or daemon.** Rejected. It outlives the turn, needs a second
   process protocol, and makes process ownership and recovery harder. The foreground
   command plus checkpoints already survives a lost session.
3. **Keep the interleaved interactive parent as the only batch path.** Rejected. One parent
   cannot keep several headless loops independent, and the parent's loss loses the set and
   the budget.
4. **Write checkpoints inside the repository.** Rejected. An untracked file changes the
   snapshot and the reviewer gate, and a committed file adds batch state to the delivery.
   The runs root is outside every work tree.
5. **Continue with a fresh full budget.** Rejected. It spends more steps than the owner
   authorized and makes the configured limit meaningless across a resume.
6. **Retry a failed loop automatically.** Rejected. A refused gate, an exhausted budget, and
   a failed child need the owner's decision; an automatic retry hides the reason and can
   repeat a remote write.
7. **Recreate a missing or replaced work tree.** Rejected. The recorded path and identity
   are necessary but not sufficient; a new work tree over the same branch can duplicate or
   lose the interrupted work. It is a `needs-owner` case.
8. **`git worktree remove` with no identity check.** Rejected. A path that was replaced
   between the record and the removal would delete another directory. The device and inode
   check, the registered-work-tree read, and the link-safe remainder remove that risk.
9. **One orchestrator session for the whole batch.** Rejected. It gives one conversation the
   tasks of several independent issues, loses per-issue session continuity, and cannot run
   the loops concurrently.
10. **Write the headless transcript after every step.** Rejected. It would close the
    hard-kill step gap, but it changes the transcript write contract of ADR 0026 and adds one
    write per charged step to every headless run. The loop stops as `needs-owner` when the
    transcript cannot prove the step count (owner decision 3).

## Owner decisions

1. **Required loop count.** `--loops` stays required. A batch starts concurrently only when
   the skill passes a count, and a missing `--loops` is a usage error.
2. **Checkpoint retention.** The batch keeps every checkpoint, transcript, and log for
   inspection. No retention bound and no cleanup rule is added.
3. **Hard-kill step accounting.** A loop stops as `needs-owner` with reason
   `unverified-steps` when the transcript cannot prove the step count. Alternative 10, a
   per-step transcript write, is not adopted.

## Authors

Andro Marces

## Links

- [Issue #1708: Propose the ADR for foreground batch scheduling](https://github.com/andromarces/agent-loops/issues/1708)
- [Issue #1709: Implement foreground batch scheduling](https://github.com/andromarces/agent-loops/issues/1709)
- [Issue #1710: Coordinate reviewer audits and issue creation](https://github.com/andromarces/agent-loops/issues/1710)
- [Issue #1711: Release loop slots on owner decisions, resume after owner merges, and notify](https://github.com/andromarces/agent-loops/issues/1711)
- [Issue #1486: State how to find the issues that open PRs close before a batch selects issues](https://github.com/andromarces/agent-loops/issues/1486)
- [Issue #1560: Check that a PR body closing keyword reached closingIssuesReferences](https://github.com/andromarces/agent-loops/issues/1560)
- [PR #1719: Propose the ADR for foreground batch scheduling](https://github.com/andromarces/agent-loops/pull/1719)
- [PR #1724: Accept ADR 0106 and settle its owner decisions](https://github.com/andromarces/agent-loops/pull/1724)
- [PR #1727: Implement foreground batch scheduling](https://github.com/andromarces/agent-loops/pull/1727)
- [Issue #1728: Report paused when another resume holds the lock of a needs-owner batch loop](https://github.com/andromarces/agent-loops/issues/1728)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch command and settings](../src/batch/cli.mjs)
- [ADR 0014: Extend the step budget of a live interactive run](0014-extend-the-step-budget-of-a-live-run.md)
- [ADR 0018: Copy untracked local files into a linked run work tree](0018-copy-local-files-into-a-linked-run-work-tree.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md)
- [ADR 0028: End the Windows process tree of a child when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)
- [ADR 0039: Gate full-suite test runs with a machine-wide test slot](0039-machine-wide-test-slot.md)
- [ADR 0040: Run the test command in a test slot and route child full suites through the wrapper](0040-run-the-test-command-in-a-test-slot.md)
- [ADR 0043: Let the headless runtime declare the PR that a worker opens](0043-let-the-headless-runtime-declare-the-pr-a-worker-opens.md)
- [ADR 0045: Gate the finish of a headless run on the PR that its runtime declares](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md)
- [ADR 0046: Default the test slot count to one](0046-default-the-test-slot-count-to-one.md)
- [ADR 0049: Pin the machine-wide roots for every child turn](0049-pin-the-machine-wide-roots-for-every-child-turn.md)
- [ADR 0073: Lock the work tree of an active run](0073-lock-the-work-tree-of-an-active-run.md)
- [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md)
- [ADR 0104: Accept a test-slot command as an argument vector](0104-accept-a-test-slot-command-as-an-argument-vector.md)
- [ADR Index](README.md)
