# 0121. Run issue, pull request, and free-text task items in one batch

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md):

- Decision 2's rule that a batch accepts GitHub issue numbers only. A batch now also accepts a
  pull request item and a free-text task item, through `--items-file`.
- Decision 3's rule that the runtime selects no issue, in the narrow sense that a pull request
  item freezes its head at start. The skill still resolves the request, and the runtime still
  reads no label, milestone, project, or natural-language request.
- Decision 4's rule that every loop gets a new branch from the base branch. A pull request item
  runs at its head, and a task item gets `batch/<batch id>/task-<id>`.
- Decision 6's fixed issue eligibility. Each kind has its own checks, and the `not-specified`
  heading check is opt-in with `--require-specification`.
- Decision 7's issue-keyed claims, checkpoints, reconciliation, resume, owner decisions,
  cleanup, and summary. They key on one item identity that covers all three kinds.

Every other decision, consequence, and acceptance check of ADR 0106, as later amended, stays in
force. The batch still never merges, approves, comments on, labels, force-pushes, resets, or
deletes a branch.

This ADR partially supersedes
[ADR 0119: Start a batch from the frozen issue set of a finished audit](0119-start-a-batch-from-the-frozen-issue-set-of-a-finished-audit.md):

- Decision 1's rule that `--from-audit` and `--issue` are the only two item sources. A third
  source, `--items-file <path>`, is added. `--from-audit` and `--issue` keep their behavior.

Every other decision of ADR 0119 stays in force, including the `created` audit rule, the stored
order, the frozen set, and the refusal before any state write.

This ADR does not supersede
[ADR 0110: Release batch loop slots on owner decisions](0110-release-batch-slots-on-owner-decisions.md)
or
[ADR 0114: Report an exit 4 batch loop as needs-owner](0114-report-an-exit-4-loop-as-needs-owner.md).
Their decisions stay in force. The keyed state they read and write, such as a decision id, a
pending decision, a loop checkpoint, and a claim, now uses the item identity of decision 7 below.

## Date

2026-11-09

## Context

`agent-loop batch start` runs one kind of work: a new worker-then-reviewer loop for a GitHub
issue on a new branch. The single-task loop is more open. It takes free task text, runs on an
existing pull request with `--pr`, and runs in `work-first`, `review-first`, or `review-only`
mode.

An owner request such as "work on every actionable item of my local work list, and review every
open PR" therefore cannot run as one batch. A free-text item has no issue number, and a pull
request cannot be reviewed in place. The batch also keys every claim, checkpoint, decision, work
tree, transcript, log, and summary entry on an issue number.

ADR 0106 fixes the foreground supervisor, the frozen set, the loop slots, the step budget, and
the cleanup. ADR 0110 and ADR 0114 compose owner decisions and exit 4 stops onto it. This ADR
changes only the item model, the per-item mode, and the keys that the existing rules use.

## Decision

### 1. `--items-file` accepts three item kinds

`agent-loop batch start` accepts `--items-file <path>`, a JSON list of items
`{ kind, number | text, mode, task, id }`. `kind` is `issue`, `pr`, or `task`. `number` is
required for `issue` and `pr`. `text` and `id` are required for `task`. `mode` and `task` are
optional. `--issue` and `--from-audit` keep their current behavior, and exactly one source is
required.

A missing or unreadable file, an unknown kind, an unknown mode, an item that is not an object, a
missing number, a task without text, a task without an id, a malformed id, a duplicate identity,
and a source combined with another source each exit 2 before any claim, work tree, checkpoint, or
child exists.

### 2. One stable item identity

An issue keeps its number as its identity, so an issue-only batch writes the same claim,
checkpoint, transcript, log, branch, and work-tree names as before. A pull request uses
`pr-<n>`. A free-text task uses `task-<id>`, where the skill makes a short unique slug from the
task text, for example `fix-help-typo`.

The identity is the claim name `${identity}.json`. The file segment is `issue-<n>` for an
issue, `pr-<n>` for a pull request, and `task-<id>` for a task. The branch of an issue is
`batch/<batch id>/<n>` and of a task is `batch/<batch id>/task-<id>`. The work tree of an issue
is `issue-<n>`, of a pull request is `pr-<n>`, and of a task is `task-<id>`. Claims,
checkpoints, transcripts, logs, reconciliation, resume, owner decisions, cleanup, and the summary
key on that identity, and a task keeps it across an interrupt and a resume.

### 3. Each item carries its own mode

Each item carries `work-first`, `review-first`, or `review-only`, the values of the single-task
`--mode`. The default is `work-first` for an issue and for a task, and `review-first` for a pull
request. The batch passes `--mode` to the child when the mode is not the default work-first, and
always for a pull request.

### 4. A pull request item runs at its head

The batch reads and freezes the pull request head at start. Before each launch it checks that
the current head equals the frozen head, and skips the item as `pr-head-moved` before any claim or
work tree with a reason that states both heads. A closed or merged pull request is skipped as
`pr-closed`.

The item runs in a detached work tree at the pull request head in every mode. The batch fetches
`refs/pull/<n>/head` and checks that the fetched commit equals the frozen head before checkout; a
commit that differs skips the item as `pr-head-moved`. No local branch is created, moved, or
reset. In `work-first` and `review-first`, the child gets `--pr <n>` and `--require-ci <n>`, and a
worker correction is pushed with `git push origin HEAD:refs/heads/<branch>`. In `review-only`, the
child gets none of `--pr`, `--require-ci`, and `--require-accept`, and the loop finishes after its
reviewer turn. The existing single-task guards that refuse `--pr`, `--require-ci`, and
`--require-accept` with `review-only` stay unchanged.

A pull request whose head is in another repository runs in `review-only`, fetched through
`refs/pull/<n>/head` and checked out detached. In `work-first` or `review-first` it is skipped as
`pr-head-foreign` before any claim or work tree.

### 5. A free-text task delivers like an issue

A task item carries its own text. In `work-first` and `review-first`, it runs on
`batch/<batch id>/task-<id>` in `task-<id>`, pushes that branch, and opens one pull request whose
body states the task and holds no closing keyword. The loop is gated with `--pr` and
`--require-ci` once that pull request exists, so reconciliation, resume, and cleanup work as for
an issue. A `task` field on any item replaces the task template for that item only.

### 6. Eligibility is per item kind

An issue keeps `closed`, `blocked`, `claimed`, and `closed-by-open-pr`. A number that is actually
a pull request is skipped as `is-pull-request` and never launched as new work. The
`not-specified` heading check is opt-in with `--require-specification`; without it an issue with
no `## Acceptance` heading launches.

A pull request checks that it is open, that it is not claimed by another batch, and that its head
is unchanged since start. A task checks only its claim. Every refusal still happens before any
claim, work tree, checkpoint, or child exists.

### 7. `review-only` succeeds after its reviewer turn

A `review-only` item ends `succeeded` once its reviewer turn ran. Its report records the
reviewer verdict (`accept`, `reject`, or `unknown`) and the findings. A `reject` is information,
not a failure, and exit codes keep today's meaning.

### 8. A pull request item closed by an issue item of the same batch

The `closed-by-open-pr` rule of ADR 0106 applies as amended by ADR 0114. An issue item that a
pull request item of the same batch closes is skipped as `closed-by-open-pr`, and the pull
request item runs.

### 9. Documentation

The `Batch runs` section of `docs/orchestrator-instructions.md`, the `Batch runs` section of
`docs/reference/usage.md`, and the `batch` help text in `src/help.mjs` document the three item
kinds, the per-item modes and defaults, the `--items-file` shape, the task identity, and how a
parent turns a mixed request into items.

### 10. Acceptance checks

1. A mixed batch with one issue item in `work-first` and one pull request item in `review-first`
   runs both loops. The issue loop runs on a new `batch/...` branch. The pull request loop gets
   `--mode review-first`, `--pr <n>`, and `--require-ci <n>`, in a work tree at the head.
2. A pull request item whose head moved after start is skipped before any claim or work tree,
   with a reason that states the frozen head and the current head.
3. A closed or merged pull request item is skipped with a named reason.
4. A pull request number given as an issue item is skipped as `is-pull-request`, never launched as
   new work on a new branch.
5. A free-text task survives interrupt and resume with the same claim, work tree, branch,
   transcript, and remaining step budget.
6. A `review-only` item never dispatches a worker, and its child gets none of `--require-accept`,
   `--pr`, and `--require-ci`.
7. A pull request item in `review-only` runs in a work tree at its head after the frozen
   head check and finishes after its reviewer turn.
8. A single-task run that combines `review-only` with `--pr`, `--require-ci`, or
   `--require-accept` is still refused with the same message.
9. Per-item task text replaces the template for that item only.
10. `--items-file` with a mixed list starts the batch, and `--issue` and `--from-audit` keep
    working unchanged.
11. A task item runs on branch `batch/<batch id>/task-<id>` in work tree `task-<id>`. A missing,
    malformed, or duplicate id exits 2 before any state write.
12. A task item in `work-first` opens a pull request with no closing keyword and ends through
    `--require-ci` for that pull request.
13. A `review-only` item ends `succeeded` after its reviewer turn, and its report names the
    verdict, including a `reject`.
14. A pull request item whose head is in another repository runs in `review-only`, and is skipped
    as `pr-head-foreign` in `work-first` or `review-first`.
15. An issue item that a pull request item of the same batch closes is skipped as
    `closed-by-open-pr`, and the pull request item runs.
16. Two batches that name the same pull request or the same free-text identity race for one
    claim, and exactly one wins.
17. An issue item with no `## Acceptance` heading launches by default, and is skipped as
    `not-specified` with `--require-specification`.
18. A malformed item, an unknown kind, an unknown mode, and a duplicate identity exit 2 before
    any batch store, claim, work tree, or child exists.
19. A batch that names none of the new options behaves as before: same branches, eligibility,
    claims, checkpoints, summary shape, and exit codes, `--from-audit` included. The opt-in
    `not-specified` check is the only named change.
20. A `status` read and a resume with nothing pending write no checkpoint.

## Consequences

- One batch can run local tasks, issue work, and pull request reviews together, bounded by the
  same loop slots and the same machine-wide test slot.
- A pull request item is a review or a correction of an existing branch. The batch still opens no
  new branch for it and never merges it.
- A task item needs a slug from the skill. The slug is the resume key, so a changed slug starts a
  different item and races for no claim.
- An issue-only batch keeps its old names and summary shape. The extra `items` field in the
  manifest is additive.
- The opt-in specification check removes a default refusal that some owners relied on. A batch
  that wants the old check passes `--require-specification`.

## Alternatives

1. **A fourth loop kind with a parallel supervisor.** Rejected. The existing supervisor already
   owns claims, checkpoints, budgets, and cleanup, and a second path would duplicate them.
2. **A new branch for a pull request item.** Rejected. The owner asked to review or correct the
   pull request in place, and a new branch would not update its head.
3. **An issue number as the identity of a task.** Rejected. A task has no issue, and a synthetic
   number would collide with a real issue and misdirect a decision or a claim.
4. **A runtime selector for "all open pull requests".** Rejected. ADR 0106 decision 3 keeps
   selection with the skill, and a selector would freeze a set that the owner did not name.
5. **Keep `not-specified` on by default.** Rejected by the owner decision: an issue item launches
   by default, and a batch that wants the structural check opts in.
6. **Run a foreign-head pull request in a work mode.** Rejected. The batch cannot push to another
   repository's branch, so only the read-only review mode applies.

## Owner decisions

1. **Input form.** Add `--items-file <path>`, a JSON list of items
   `{ kind, number | text, mode, task, id }`. Keep `--issue` and `--from-audit` unchanged.
2. **Free-text task identity.** The skill makes a short unique slug `id`. A missing, malformed, or
   duplicate id exits 2 before any state write.
3. **Free-text task delivery.** In `work-first` and `review-first`, a task pushes its branch and
   opens a pull request with no closing keyword, then ends through `--require-ci`.
4. **`review-only` result.** It ends `succeeded` after the reviewer turn, and the report records
   the verdict and findings. A `reject` is information, not a failure.
5. **A pull request head in another repository.** It runs in `review-only`, and is skipped as
   `pr-head-foreign` in a work mode.
6. **An issue closed by a pull request of the same batch.** The issue is skipped as
   `closed-by-open-pr`, and the pull request runs.

## Authors

Andro Marces

## Links

- [Issue #1751: Let batch start run a mix of issue, pull request, and free-text items, each with its own loop mode](https://github.com/andromarces/agent-loops/issues/1751)
- [PR #1753: Run issue, pull request, and task items in one batch](https://github.com/andromarces/agent-loops/pull/1753)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0110: Release batch loop slots on owner decisions, resume after merges, and notify](0110-release-batch-slots-on-owner-decisions.md)
- [ADR 0114: Report an exit 4 batch loop as needs-owner](0114-report-an-exit-4-loop-as-needs-owner.md)
- [ADR 0119: Start a batch from the frozen issue set of a finished audit](0119-start-a-batch-from-the-frozen-issue-set-of-a-finished-audit.md)
- [Implementation: batch item identity](../src/batch/items.mjs)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch eligibility](../src/batch/eligibility.mjs)
- [Implementation: batch command and settings](../src/batch/cli.mjs)
- [ADR Index](README.md)
