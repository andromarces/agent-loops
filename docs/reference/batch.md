# Batch runs

`agent-loop batch start` owns one batch of issue, pull request, and task items for its whole life. It runs in the foreground and prints progress on stderr. It returns one JSON summary on stdout when every selected issue is terminal, when an owner decision is pending, or when the batch is interrupted. There is no daemon and no detached supervisor. [ADR 0106](https://github.com/andromarces/agent-loops/blob/main/adr/0106-foreground-batch-scheduling.md) is the design.

## Commands and settings

```bash
agent-loop batch start --repo <main work tree> --issue 1709 --issue 1710 \
  --orchestrator codex --worker claude --reviewer agy --loops 2 --max-steps 20
agent-loop batch start --repo <main work tree> --items-file items.json \
  --orchestrator codex --worker claude --reviewer agy --loops 2 --max-steps 20
agent-loop batch start --repo <main work tree> --from-audit <audit id> \
  --orchestrator codex --worker claude --reviewer agy --loops 2 --max-steps 20
agent-loop batch status --batch <id>
agent-loop batch resume --batch <id>
agent-loop batch answer --batch <id> --decision <decision id> --option <key>
```

`start` requires `--repo` (the main work tree, never a linked one), one item source, `--orchestrator`, `--worker`, `--reviewer`, `--loops` (1 to 64), and `--max-steps`. The item source is explicit `--issue <n>` entries (launch order, duplicates refused). The other forms are a `--items-file <path>` JSON list, or `--from-audit <audit id>` for the frozen set of a finished audit. Two sources together, and a command with none, are refused. It accepts `--base`, `--work-tree-root`, `--task-template`, `--require-specification`, `--setup-cmd`, `--setup-timeout`, `--test-cmd`, `--test-cmd-timeout`, `--timeout`, `--reviewer-sandbox`, and the `--<role>-model` and `--<role>-effort` flags. The remaining values keep their headless defaults, and every supplied value goes through the headless parser.

`--items-file` holds a JSON list of items `{ kind, number | text, mode, task, id }`. `kind` is `issue`, `pr`, or `task`. `mode` is `work-first`, `review-first`, or `review-only`, the same values as the single-task `--mode`. The default is `work-first` for an issue and for a task, and `review-first` for a pull request. `task` replaces the task template for that item only. A `task` item needs a short unique slug `id`, and its task text in `text`.

A missing, malformed, or duplicate identity, an unknown kind or mode, and a malformed item each exit 2 before any state write. A `task` item runs on branch `batch/<batch id>/task-<id>` in the work tree `task-<id>`. In `work-first` and `review-first`, its worker pushes that branch and opens one pull request whose body states the task and holds no closing keyword. The loop then ends through `--require-ci` for that pull request.

`--base` defaults to the remote default branch and is refused when `origin/<base>` does not exist. `--work-tree-root` defaults to `<repo parent>/<repo name>-batch-<batch id>`. A root inside any Git work tree, or one the batch cannot write, is refused.

The task template accepts `{issue}`, `{title}`, `{branch}`, and `{repo}`. An unknown placeholder or a template without `{issue}` when an issue item uses it is a usage error. The default issue template names the issue, the branch push, and the closing pull request. A pull request item uses a review-oriented default template, and a task item delivers its own text plus the push and pull-request instructions.

`--max-steps` is required. A duplicate or conflicting sandbox flag and a runs root inside any Git work tree are also refused. An unknown model or effort value logs one warning. `--timeout 0` passes no timeout to each headless child.

Every refusal happens before a claim, work tree, checkpoint, or child exists, and exits 2.

## Selection and eligibility

The runtime selects no item. The skill resolves the request into explicit `--issue` numbers, an explicit `--items-file` list, or the frozen set of a finished audit with `--from-audit <audit id>`. That set is frozen at `start`. A later resume reads the same set.

An issue or pull request opened after `start` is never added, and an item removed from the set is not replaced. A mixed request such as "work on every item of my local list, and review every open pull request" is resolved by the skill. The result is one `--items-file` list: each local item becomes a `task` item with its own slug, and each pull request becomes a `pr` item. The runtime adds no query selector such as "all open pull requests".

`--from-audit` reads the frozen set of an audit in the `created` state, in the stored order, without sorting or dedupe. It refuses with exit 2 before any state write when the audit is unknown, unreadable, running, paused, `needs-owner`, or interrupted. It also refuses an audit that has a `pendingCreate` write that was not reconciled, or one that holds a `created` entry outside its frozen set. It refuses an audit that belongs to another repository, or has an empty, malformed, or duplicate set. The audit command never starts a batch, and the batch command never starts an audit. [ADR 0119](https://github.com/andromarces/agent-loops/blob/main/adr/0119-start-a-batch-from-the-frozen-issue-set-of-a-finished-audit.md) is the design.

Before each launch the batch refreshes one item and skips it with one named reason:

- an issue keeps the reasons `closed`, `blocked`, `claimed`, and `closed-by-open-pr`. An issue that is actually a pull request number is skipped as `is-pull-request` and never launched as new work. `not-specified` applies only with `--require-specification`; without it an issue with no `## Acceptance` heading launches.
- a pull request item reads its state, fork flag, and head. A closed or merged pull request is skipped as `pr-closed`. A head in another repository is skipped as `pr-head-foreign` in `work-first` and `review-first`, and runs in `review-only`. A head that differs from the head frozen at start is skipped as `pr-head-moved`, and the reason names both heads. A live claim of another batch skips it as `claimed`.
- a task item checks only its claim.
- `eligibility-unverified`: the read failed, or returned an unreadable value.

A pull request item runs in a work tree on its head branch in every mode. The head is fetched through `refs/pull/<n>/head`, and a fetched commit that differs from the head frozen at start skips the item as `pr-head-moved`. A missing local branch is created at that head. A branch at the head or behind it is used, with a fast-forward in the second case. A branch with commits the frozen head lacks is skipped as `pr-branch-diverged`.

One checked out in another work tree is skipped as `pr-branch-checked-out`. No branch is forced or reset. On resume, a moved head is accepted only when the loop's own transcript records that head from a worker or reviewer turn. The frozen head must also be an ancestor of it. Any other move stops as `needs-owner` with a reason that names both heads.

`work-first` and `review-first` pass `--pr` and `--require-ci` for that pull request, and a worker correction is pushed with `git push -u origin <branch>`. `review-only` passes none of `--pr`, `--require-ci`, and `--require-accept`, and the loop finishes after its reviewer turn. A `review-only` item ends `succeeded` after that turn, and its report records the reviewer verdict, findings, blockers, notes, and deferred items in separate fields. A `reject` is information, not a failure. A pull request item whose head is in another repository runs on a local branch at the pull request head in `review-only`.

A failed batch-wide read pauses the queue, leaves the unread issues `queued`, and resumes them on the next `batch resume`. The skip report is part of the summary and the checkpoint.

## Loop slots and test slots

`--loops` bounds live headless runs of one batch. It is not machine-wide. A free slot is filled from the frozen set in order. A run holds its slot until it is terminal or the batch stops. A `needs-owner` loop becomes a pending decision and releases its slot once no recorded child process is live. A `waiting` loop holds no slot.

Every `--test-cmd` run still passes through the machine-wide test slot, whose default count is 1. Two loops can therefore run together while their full suites serialize.

## Owner decisions

A loop that stops as `needs-owner` records a pending decision. The decision has a unique id, the reason, the evidence, two option keys, and one recommendation. A normal state offers `resume`, which is recommended, and `abandon`. A loop whose step count cannot be proven offers `abandon`, which is recommended, and `skip`. A loop that exits 4 offers the normal options under reason `pr-head-unresolved`.

`batch status` shows the decision state, the option keys, and the recommendation. A pending decision keeps its claim, work tree, transcript, and remaining budget. It holds no loop slot once no recorded child process is live.

`agent-loop batch answer` binds one listed option to one decision. The answer file is created with no overwrite, so two answers to one decision have exactly one winner. An unknown batch, an unknown decision, another batch's decision, an answered decision, and an unlisted option exit 2 and write nothing.

An answer of `resume` puts the loop back in the queue, and `batch resume` continues it with the remaining budget. An answer of `abandon` ends the loop as `failed` with reason `owner-abandoned` and releases its claim. An answer of `skip` ends it as `skipped` with reason `owner-skipped` and releases its claim. A malformed decision or answer fails closed and is reported.

## Waiting for a blocker merge

An issue with an open blocking issue becomes `waiting` instead of a final skip. The checkpoint records `skipReason: "blocked"` and `blockingIssues`, and the issue holds no claim, work tree, or slot.

The batch re-checks a waiting issue every 15 seconds on a monotonic clock. A closed issue is reported as `skipped` with reason `closed` and launches nothing. A failed poll read logs a warning and retries on the next poll. When every blocker closes, the issue returns to the queue and launches in the next free slot, with no new start command.

A waiting issue keeps the foreground command live until its blockers close or the command is interrupted. A pending decision does not keep it live, because only the owner can answer it.

## Notifications

On macOS and Windows the batch sends a desktop notification for four events. The events are a new pending decision, a required owner merge, a state where only owner merges remain, and batch completion. Linux and other platforms spawn nothing.

The notifier passes the text as an argument on macOS and as environment values on Windows. The text never enters a script. The notifier bounds the text, the process time, and its own child. A failure logs a warning and never fails the batch.

## Claims and checkpoints

The local claim of one repository and item is `<runs root>/batches/claims/<repo key>/<identity>.json`. The repo key is the first 12 hex characters of the SHA-256 of the canonical main work tree path with the Windows drive letter lowercased. An issue identity is its number, a pull request identity is `pr-<n>`, and a task identity is `task-<id>`. It is created atomically with no overwrite, and a partial or unparseable claim counts as held. A claim exists from launch until the loop is terminal. A `failed` loop releases it; an `interrupted` or `needs-owner` loop keeps it.

The batch store is `<runs root>/batches/<batch id>/`. In it, `batch.json` holds the frozen item list, settings, and batch status; `loops/<segment>.json` holds one checkpoint. `transcripts/<segment>.json` holds the headless transcript; `logs/<segment>.<attempt>.log` holds the child output. The segment is `issue-<n>` for an issue, `pr-<n>` for a pull request, and `task-<id>` for a task. The runs root is `AGENT_LOOP_RUNS_ROOT`, else `<os tmpdir>/agent-loops/runs`. Set it to a stable path when a checkpoint must survive a reboot.

The store also holds `decisions/<decision id>.json` and `answers/<decision id>.json`. Each file is created with no overwrite, and a partial or unreadable file fails closed.

Checkpoints are written on an event only. The events are `start`, a launch, a skip, a child exit, a reconciliation change, a decision or wait change, and the final status. There is no heartbeat and no periodic write. `batch status` writes nothing, and a resume with nothing to do writes nothing.

## Loop statuses and the summary

A loop is `queued`, `running`, `waiting`, `succeeded`, `skipped`, `failed`, `needs-owner`, or `interrupted`. `batch status` reports a `running` loop whose recorded owner is dead as `stale` and names `batch resume` as the next action. It also shows each pending decision's options and recommendation, each required merge, and the completion state. A `needs-owner` loop with reason `pr-head-unresolved` names its pull request and the next action.

`start` and `resume` print progress on stderr and one JSON object on stdout with the batch id, status, and one entry per item. Each entry holds its identity in `issue` (an issue number, `pr-<n>`, or `task-<id>`). A non-issue item also holds its `kind` and `mode`. The entry holds loop status, reason, work tree, branch, pull request, attempts, steps used, and remaining steps.

It also holds log, transcript, cleanup result, and report. A `review-only` report also holds the reviewer `verdict` (`accept`, `reject`, or `unknown`). It keeps the reviewer findings, blockers, notes, and deferred items in `reviewerFindings`, `reviewerBlockers`, `reviewerNotes`, and `reviewerDeferred`. A batch that names only `--issue` keeps the previous entry shape.

The report holds the last attempt's finish summary, error, failed-turn test result, and delete-by-hand warnings. It also holds a `state`: `read`, `no-attempt`, `unread`, or `missing`. A `state: "read"` report with a null `summary` also holds `lastTurnItems`: the last child turn's role, `deferred`, `notes`, and `blockers`. An `unread`, `missing`, or `no-attempt` report omits the field. A last turn without a parsed report reads null items and a `reason`.

The transcript warning list and the report keep 20 warnings, and `warningsOverflow` names the rest. A capped array in the report keeps its first 20 entries, and a `<field>Overflow` count beside it names the rest. A `transcriptRead` value with `ok: false` means the transcript was unread. Every summary, error, test, and warning field is then null.

Exit codes:

- `0`: every selected issue ended `succeeded` or `skipped`.
- `1`: a loop ended `failed` or `needs-owner`, the batch waits on a decision or merge, or the queue paused.
- `2`: a refused setting, or a refusal before any state write.
- `130`: SIGINT ended the batch.

## Interruption and resume

The first SIGINT stops new launches, forwards SIGINT to each live child, and waits up to 30 seconds for each to exit. Each child writes its transcript and exit code. The batch then writes every checkpoint, marks unfinished loops `interrupted`, keeps every work tree and claim, and exits 130. A second SIGINT ends the child trees without waiting. A hard kill runs no handler; the next `batch resume` checks process ownership before anything else.

A run that throws while a child is live stops that child the same way, writes the same checkpoints, and rethrows the error.

`batch resume` runs each non-terminal loop in order:

1. A checkpoint whose process still lives is not restarted. The resume waits for that process and reconciles it from its transcript. An identity that cannot be read stops the loop as `needs-owner`.
2. The steps used are the sum of the transcript's segments split at each `continued` event. That sum is the highest `result` count of each segment, plus one for a trailing dispatched turn with no result. The checkpoint count is a cross-check, and the larger value wins. A transcript that cannot prove a count stops as `needs-owner` with reason `unverified-steps`.
3. `remaining = --max-steps at start - steps used`. Zero marks the loop `failed` with reason `step-budget-exhausted`; a positive remainder becomes the next attempt's `--max-steps`.
4. GitHub is reconciled before any repeat (below).
5. The attempt continues the same transcript with `--continue-from <transcript> --transcript <same path> --max-steps <remaining>`. A matching open pull request is supplied as both `--pr <n>` and `--require-ci <n>`.

A pending decision with no answer stays pending and keeps its slot free once no recorded child process is live. A malformed decision or answer keeps the loop `needs-owner` and logs a warning. An answer of `resume` returns the loop to the queue, and an answer of `abandon` ends it as `failed`. An answer of `skip` ends it as `skipped`. A live answer refreshes eligibility, takes the loop lock, and continues the same transcript.

The eligibility check ignores the loop's own open pull request that closes its issue. Another branch's pull request still skips the loop. A live answer and a `batch resume` answer share one continuation step. The step applies the `step-budget-exhausted` check before it reconciles and launches.

A `waiting` issue is re-checked on the same 15-second poll, and it launches after its blockers close. Both states survive an interrupted session, so `batch resume` keeps them.

## GitHub reconciliation

Before a resumed attempt, and before any launch that follows an uncertain exit, the batch reads the work tree head and status. It also reads the fetched remote branch, the pull requests for the branch, the issue state, and the commit count. It then applies these rules:

- A missing or replaced work tree, or another branch checked out, is `needs-owner`.
- A merged pull request of this branch that holds every local commit, on a closed issue, is `succeeded` and eligible for cleanup.
- A merged pull request that lacks a local commit is `needs-owner` with `unpushed-local-work`.
- A closed issue with no merged pull request, or a closed-unmerged pull request, is `needs-owner`.
- One open pull request whose head equals the local and remote heads on a clean tree resumes with `--pr` and `--require-ci`.
- Another open head, more than one open pull request, a remote head that differs, or a diverged branch is `needs-owner`.

The batch never force-pushes, resets, merges, reopens, or deletes a branch to make a state fit.

## Failure isolation and cleanup

A loop that ends on headless exit 1 or 2 is `failed` with its reason. A failed setup (`setup-failed`), a refused finish, or a child error is also `failed`. It is not retried, and its failure stops neither another loop nor the queue. It releases its claim and keeps its work tree, branch, transcript, and log.

A loop that exits 4 is `needs-owner` with reason `pr-head-unresolved`. It keeps its claim and work tree. Its decision offers `resume` and `abandon`. `resume` reconciles the pull request, so a merged pull request ends the loop `succeeded`. With no remaining step budget, resume fails with `step-budget-exhausted` before reconciliation.

Cleanup removes a work tree only for a `succeeded` loop, and only after every check passes. The path is the recorded path under the batch root and not the main work tree, and `git worktree list` names it. The recorded branch is checked out, the device and inode still match, and the tree is clean. Every local commit is pushed, merged, or on the base branch. No other live process holds the claim, and no live run lock names the tree.

A failed, interrupted, `needs-owner`, or live loop keeps its tree, and so does a success whose proof or removal fails. When cleanup succeeds, the work tree and claim are removed. The branch, pull request, transcript, log, and checkpoint stay.

The batch never removes the main work tree or any path outside its own root. General system temporary directory cleanup stays out of scope. A hard-killed session leaves a checkpoint that the next session resumes. A transcript that never recorded a step count cannot prove the remainder, so that loop stops as `needs-owner`.

## Reviewer audits

`agent-loop batch audit start` coordinates two or more read-only reviewers on one project revision and turns their findings into issues without duplicates. It runs in the foreground and returns one JSON summary. [ADR 0109](https://github.com/andromarces/agent-loops/blob/main/adr/0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md) is the design, and [ADR 0120](https://github.com/andromarces/agent-loops/blob/main/adr/0120-take-an-operator-focus-and-keep-every-actionable-finding.md) defines the operator focus and the keep-every-actionable-finding rule.

```bash
agent-loop batch audit start --repo <main work tree> \
  --reviewer claude --reviewer agy --worker codex
agent-loop batch audit status --audit <id>
agent-loop batch audit resume --audit <id>
agent-loop batch audit approve --audit <id>
agent-loop batch audit remove --audit <id>
```

`start` requires `--repo` (the main work tree, never a linked one), at least two `--reviewer` entries, and `--worker`. A `--reviewer-model` or `--reviewer-effort` after a `--reviewer` sets that reviewer's value; `--worker-model` and `--worker-effort` set the consolidation worker's values. It accepts `--base`, `--work-tree-root`, `--setup-cmd`, `--setup-timeout`, `--timeout`, `--reviewer-sandbox`, and `--focus <text>` or `--focus-file <path>`. The two focus flags are mutually exclusive, and an empty or blank focus is refused.

A supplied focus is the only goal of each reviewer turn. Without a focus, each reviewer reports any item someone can act on, defects included. The sandbox flag is accepted only when every reviewer is `codex`. Every refusal exits 2 before a store, work tree, or child exists.

The focus is stored in the audit record. `batch audit resume` and `batch audit approve` reuse the stored focus and accept no focus flag. Either flag is a refused setting that exits 2 and writes nothing. `batch audit status` shows the stored focus.

The command resolves `origin/<base>` once to a commit SHA and creates one detached work tree at that SHA. Every reviewer reads the same work tree and revision, in its own session and in the requested order. A reviewer never sees another reviewer's findings.

The reviewer turn uses the existing reviewer prompt, including its test-slot, secret-file, process, and sandbox rules. A Codex reviewer runs with no sandbox unless `--reviewer-sandbox` names one. A `--setup-cmd` runs once in the work tree before the first reviewer and must leave the checkout clean. A tracked or unignored change stops the run as `needs-owner` and starts no reviewer.

After each reviewer turn the runtime reads the work tree HEAD and `git status --porcelain`. A changed HEAD or a non-empty status fails that audit and stops the run as `needs-owner` with reason `work-tree-changed`. No later reviewer runs, and the runtime deletes or restores nothing. A fatal snapshot failure stops the run before another reviewer. The owner restores the checkout and runs `batch audit resume`. A resume reuses a saved result only when it names the current revision; otherwise the reviewer runs again.

Each reviewer returns a fenced JSON document with a `findings` array of `title`, `body`, and `evidence` entries. A turn that fails, returns no string, or returns no valid document is a failed audit. No consolidation and no issue starts until every requested audit succeeds.

After every audit succeeds, one consolidation worker merges the findings. It compares them with the open and closed issues read once with `gh issue list --state all --limit 1000`. It merges duplicates and keeps every item someone can act on that any reviewer reported, even an item outside the focus. It never drops a finding because it is not a defect. It returns one consolidated `findings` array whose entries hold `title`, `body`, `evidence`, and `existingIssue`. The runtime validates the document: every title and body is non-empty, no two titles are equal, and every named issue is in the stored list.

The runtime then creates one issue per finding that no issue covers. A finding with a named existing issue links that issue. A finding whose title exactly equals an open or closed issue also links that issue, even when the worker named none. Otherwise the runtime creates the issue with `gh issue create`; the body carries the audit id, a stable finding identity, and the revision.

Before the write the runtime records that identity, and on a retry it reads the issue bodies and adopts the issue whose body carries it. The identity does not depend on the current title, so a reworded re-audit links the same issue instead of creating a duplicate. The worker never writes to GitHub.

A failed audit pauses the run and creates no issue. `batch audit resume` retries only the reviewers that failed, then continues. `batch audit approve` records the owner's approval of the partial results, consolidates only the audits that succeeded, and continues. The approval is bound to the exact failed reviewer set and audited revision. A changed set, a changed revision, or a checkout drift discards it and requires a new approval. An approval never covers a failed consolidation.

The audit store is `<runs root>/batches/audits/<audit id>.json`. It holds the revision, work tree identity, every reviewer result, the consolidation, the stored issue list, each created issue, and the frozen issue set. It is written atomically and only on a change; `batch audit status` writes nothing. After creation the issue set is frozen: a later `resume`, `approve`, or `status` changes no entry and creates no issue.

Exit codes:

- `0`: the audit created its issue set, or `remove` deleted a finished audit.
- `1`: the audit paused at a failed audit, a failed consolidation, a failed read, or a failed creation. It also stopped as `needs-owner` at a changed checkout, or `remove` kept the audit.
- `2`: a refused setting, or a refusal before any state write.
- `130`: SIGINT ended the audit.

The audit keeps its work tree and store for inspection until the owner removes them. `agent-loop batch audit remove --audit <id>` removes both only for a finished audit: status `created`, a frozen issue set, and no unreconciled issue write. It removes the work tree first, then the store, and the audit root only when it is empty. A `paused`, `needs-owner`, `interrupted`, or running audit, and an audit whose issue write is unreconciled, keeps both and the summary names the reason. The removal checks the recorded path, root, identity, registration, frozen revision, cleanliness, and work-tree lock, and it follows no link or junction. The audit creates no label, comments on no issue, and edits no issue.
