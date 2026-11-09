# 0110. Release batch loop slots on owner decisions, resume after merges, and notify

## Status

partially-superseded

## Superseded by

[adr/0117-state-the-held-lock-paused-rule-and-its-precedence.md](0117-state-the-held-lock-paused-rule-and-its-precedence.md) partially supersedes this ADR. The replaced part is the held-lock sentence of decision 9, which states the `paused` report but states no precedence. The rest of decision 9 and every other decision, consequence, and acceptance check stays in force.

## Supersedes

This ADR partially supersedes
[ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md).
These parts of `adr/0106-foreground-batch-scheduling.md` are replaced:

- Decision 1's return rule. The foreground command also returns with status `waiting` when a
  pending decision needs the owner.
- Decision 5's sentence that a `needs-owner` loop keeps its slot. A loop that becomes a pending
  decision releases its slot once no recorded child process is live, and the next eligible issue
  takes it.
- Decision 6's `blocked` skip. A blocked issue waits and is polled, and it launches after its
  blockers close. It is not a final skip.
- Decision 16's deferred in-batch decision request, slot release, owner-merge continuation, and
  desktop notifications. `adr/0110-release-batch-slots-on-owner-decisions.md` provides all four.
- The consequence that a `needs-owner` loop holds a slot until milestone 3. The milestone 1
  standalone sentence also says that such a loop holds one slot.

Every other decision, consequence, and acceptance check of `adr/0106-foreground-batch-scheduling.md` stays in force. The batch
still never merges, approves, comments on, labels, force-pushes, resets, or deletes a branch.

[adr/0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md](0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md) decision 13 defers an in-batch decision, a slot release, owner-merge continuation, and notifications to milestone 3. This ADR provides those capabilities. This ADR supersedes no part of `adr/0109-coordinate-reviewer-audits-and-consolidated-issue-creation.md`.

## Date

2026-11-09

## Context

`adr/0106-foreground-batch-scheduling.md` runs one foreground batch of headless loops. A loop that stops as `needs-owner` keeps
its slot, because milestone 1 has no answer path. A selected issue that an open issue blocks is
a final skip, so the owner starts a new batch after the blocker closes. The owner sees neither
event without reading `batch status`.

Milestone 3 needs four capabilities. A loop releases its slot while it waits for an owner
decision, once no recorded child process is live. The owner answers one decision by its id and
one option. A blocked issue resumes in
the running batch after its blockers close. A desktop notification announces a new decision, a
required merge, and batch completion on macOS and Windows.

The accepted `adr/0106-foreground-batch-scheduling.md` already fixes claims, checkpoints, budgets, gates, and cleanup. This ADR
composes those rules and changes only the slot, blocking, answer, and notification behavior.

## Decision

### 1. A `needs-owner` loop becomes a pending decision and releases its slot

Every transition that `adr/0106-foreground-batch-scheduling.md` records as `needs-owner` now creates a pending decision. The
decision holds a unique id, the issue, the reason, the evidence, two or more option keys, and one
recommended option. The id is `<batch id>-issue-<issue>-<attempt>-<reason hash>`, so it is
unique across batches. A new stop after an applied answer appends a short nonce.

The loop checkpoint keeps the decision id in `decision`. A later `needs-owner` transition with
the same reason reuses that decision while its answer is not applied. A new stop after an applied
answer creates a new decision with a new id.

A loop with a pending decision is not terminal. The batch counts it as no live slot once no
recorded child process is live, so the next eligible issue launches in the freed slot. The loop
keeps its claim, work tree, transcript, and remaining step budget, as
`adr/0106-foreground-batch-scheduling.md` decision 7 states for `needs-owner`.

A loop holds its slot while its recorded child process is alive or its identity cannot be read.
The batch releases the slot only after the process is proven dead. `--loops` counts every such
live or unproven child.

A normal decision offers `resume` and `abandon`. `resume` is recommended. `resume` returns the
loop to the queue after the owner resolves the local or remote state. `abandon` ends the loop as
`failed` with reason `owner-abandoned`, releases its claim, and keeps its work tree.

A decision lists only options that recovery can carry out. A loop whose step count cannot be
proven offers `abandon` and `skip`, and no resume option. Every other state offers `resume` and
`abandon`.

### 2. The answer command binds one option to one decision

The new command is:

```bash
agent-loop batch answer --batch <id> --decision <decision id> --option <key>
```

The answer is bound to that batch id and that decision id only. The command refuses an unknown
batch, an unknown decision, and a decision of another batch. It also refuses an answered decision
and an option that the decision does not list. A refusal exits 2 and writes nothing.

A malformed decision file, a malformed answer file, and a loop checkpoint that does not name the
decision each exit 1 and write nothing. The reader never guesses a missing option or a partial
record.

A successful answer prints one JSON object on stdout and exits 0. `resume` sets the loop
checkpoint to `queued`. `abandon` sets it to `failed` with reason `owner-abandoned`. `skip` sets
it to `skipped` with reason `owner-skipped`. Both terminal options release the claim.

An answer never clears or changes the recorded process identity. A live process keeps the loop
pending, and recovery applies the answer after the process is proven dead.

### 3. An exclusive answer file makes two answers race safely

The answer is `<runs root>/batches/<batch id>/answers/<decision id>.json`. The decision is
`<runs root>/batches/<batch id>/decisions/<decision id>.json`. Both are written with an exclusive
create and no overwrite, so a contender sees either no file or a complete record.

Two answer commands for one decision both read the pending decision. Exactly one creates the
answer file. The other sees the existing file and refuses with exit 2. A partial or unparseable
decision or answer file fails closed and is reported, and no answer is applied.

The answer file is written before the loop checkpoint changes. A crash between the two leaves the
answer recorded, and the next `batch resume` applies it. An answer write is guarded by an
observable change, so a repeated answer never rewrites the file.

A repeated decision create writes no file, not even a temporary one. A resume of only an
unanswered decision writes neither the manifest nor the checkpoint.

### 4. A resume answer returns the loop to the queue with the remaining budget

`batch resume` reads the pending decision first. A pending decision with no answer keeps its
`needs-owner` status and stays pending. It holds no slot once no recorded child process is live,
and it is reported again. A malformed decision or answer keeps the loop `needs-owner` and logs a
warning. The resume never guesses an answer.

Recovery checks process ownership first. A live or unreadable identity keeps the loop pending,
and the answer applies only after the process is proven dead.

An answer with `abandon` ends the loop as `failed` and releases its claim. An answer with
`resume` sets the loop `queued`, and the normal recovery path re-checks the recorded state.

Every path that applies an answer, live or on resume, ends with the same batch finalization. That
path sets the status, summary, exit code, and one completion notification.

An answer never invents a step budget. A loop whose steps cannot be proven offers no resume
option, so no answer takes the fresh-launch path.

The resumed attempt keeps the remaining step budget rules of `adr/0106-foreground-batch-scheduling.md` decision 10. It continues
the same transcript, passes `--continue-from`, and passes `--max-steps <remaining>`. A zero
remainder ends the loop as `failed` with reason `step-budget-exhausted`. A relaunch waits for a
free loop slot, because the answer does not hold one.

### 5. A blocked issue waits on a bounded poll and launches after its blockers close

An issue with at least one open blocking issue becomes `waiting` instead of `skipped`. Its
checkpoint records `skipReason: "blocked"`, the reason, and `blockingIssues`. It holds no claim,
no work tree, and no slot, because no launch happens.

The supervisor re-checks each waiting issue on one poll interval. The interval is 15 seconds, and
an internal `pollIntervalMs` option lets a test shorten it. Every interval and age reads a
monotonic clock, never `Date.now()`.

A blocked issue whose blockers all close returns to the queue and launches in the next free slot.
An issue that closes while it waits is `skipped` with reason `closed` and launches nothing. A
failed read during the poll logs a warning, launches nothing, and retries on the next poll.

The poll and the answer check run while children run. A free slot is filled as soon as a waiting
issue becomes eligible. Each poll read has a stated timeout and the abort signal. A read at the
bound counts as a failed read.

The batch stays live while a waiting issue exists, so the owner needs no new start command. A
decision-waiting loop does not keep the batch live, because only the owner can answer it.

### 6. Desktop notifications on macOS and Windows announce three events

A notification is sent for a new pending decision, a required owner merge, and batch completion.
A required owner merge is a `waiting` issue with at least one open blocking issue. Batch
completion is the final status `completed` or `failed`. Linux and other platforms spawn nothing.

The notifier spawns one command with an argument vector and no shell. On macOS it runs `osascript`
with `on run argv`, and the title and text are two argv entries. On Windows it runs
`powershell.exe -NoProfile -NonInteractive` and passes the title and text in environment
variables. No notification text is interpolated into a script.

The notifier bounds the text length and removes control characters other than a newline and a
tab. It bounds the process time and ends only its own child on the bound. A missing binary, a non-zero exit, and a timeout log a
warning. A notification never fails or stalls the batch.

Tests inject the notifier and a clock. A test passes quotes, backticks, `$()`, `%`, newlines, and
non-ASCII text through the argument vector that the notifier builds.

### 7. A pending decision or merge wait survives an interrupted session

A pending decision and a `waiting` issue are checkpoint states. `batch resume` reads both. It
keeps a pending decision pending and keeps its slot free once no recorded child process is live.
It re-checks a waiting issue on the same poll interval and launches it after its blockers close.

The batch status `waiting` covers both cases. The command exits 1, and no completion notification
is sent while either state remains. The owner answers a decision or merges a blocker, and runs
`batch resume` only when the batch is not live.

The running supervisor applies a live answer to its in-memory loop, queue, status, and completion
check. It sends one completion notification when the batch completes.

A resume runs every ownership and lock check before it decides that no work remains. The no-op
shortcut skips only the write.

### 8. `batch status` shows the decision and wait details

Each loop entry of `batch status` carries `decision`, `blockingIssues`, and `requiredMerges`.
`decision` holds the id, reason, evidence, option keys, recommendation, answer, and state. The
state is `pending`, `answered`, or `malformed`.

The batch entry carries `completion: { status, complete }`. `complete` is true only for the
statuses `completed` and `failed`. `batch status` writes nothing.

### 9. Milestone 2 owner stops stay with the audit commands

An audit run that stops as `needs-owner` for `work-tree-missing` does not use the decision protocol, because the audit holds no batch loop slot. An audit run that stops for `work-tree-changed` also stays with `batch audit resume`, because the audit holds no loop slot. An audit that pauses for a retry or approval keeps its own `batch audit resume` and `batch audit approve`, because it holds no loop slot.

A batch loop whose resume lock is held reports `paused` and keeps its existing decision, as #1728 requires.

### 10. Documentation for milestone 3

The implementation updates the batch text of `docs/reference/usage.md`,
`docs/reference/architecture.md`, `docs/orchestrator-instructions.md`, and `src/help.mjs`. The
orchestrator instructions replace only the sentence that defers decisions, slot release, and merge
continuation. README and onboarding expansion stay out of scope.

### 11. Acceptance checks for milestone 3

The implementation passes these checks:

1. A pending decision frees its slot once no recorded child process is live, and the next
   eligible issue launches in it.
2. Each decision lists at least two option keys and one recommendation, and `batch status` shows
   them.
3. An answer to one decision never resolves another pending decision.
4. An answer resumes the loop after the owner resolves the state, within the remaining budget.
5. A blocked issue waits, is re-checked on the poll, and launches after its blockers close.
6. A poll read failure warns and retries, a closed issue is reported and not launched, and an
   abort ends the wait.
7. A decision and a merge wait survive `batch resume`, with the decision slot still free.
8. A notifier command receives the text as an argument or environment value on macOS and Windows.
   Linux and other platforms spawn nothing.
9. A malformed decision or answer fails closed, and a refused answer writes nothing.
10. A notification is injected in tests, and no test shows a desktop notification.

## Deferred capabilities

- Notifications on Linux.
- Reviewer audit coordination (milestone 2, #1710).
- Combined validation merges.
- README and onboarding expansion.
- A machine-wide loop slot.

## Consequences

- A large batch no longer stalls behind an owner decision, because the waiting loop frees its
  slot.
- The owner answers one decision at a time, and the answer id prevents a cross-decision mistake.
- A blocked issue keeps the foreground command live until its blockers close or the command is
  interrupted.
- A batch with a pending decision exits 1 with status `waiting`, so the owner sees the decision.
- A desktop notification is best effort. Its failure is a warning and never a batch failure.
- The decision and answer files are local and unsigned, like the checkpoint. A well-formed edit
  can misdirect an answer, and the live checks fail closed on every mismatch.

## Alternatives

1. **Keep the slot while a loop waits for a decision.** Rejected. It is the `adr/0106-foreground-batch-scheduling.md` behavior
   that stalls the batch, and the issue asks for the release.
2. **Answer through a GitHub comment or label.** Rejected. The repository forbids a new label
   without authorization, and a remote write is not atomic.
3. **Poll every blocked issue in the launch path.** Rejected. A failed read pauses the whole
   queue. The waiting poll keeps the queue live and retries its own read.
4. **Run a detached notifier.** Rejected. It can outlive the command. One bounded child is enough.
5. **Interpolate notification text into the script.** Rejected. A quote or a shell metacharacter
   changes the command. An argument vector and an environment value carry the text safely.
6. **Resolve a merge wait with a new start command.** Rejected. The issue asks for automatic
   continuation in the running batch, with no new start.

## Owner decisions

1. **Decision options.** A normal pending decision offers `resume` and `abandon`, and recommends
   `resume`. A loop whose step count cannot be proven offers `abandon` and `skip`, and recommends
   `abandon`.
2. **Blocked wait.** A blocked issue waits on a 15-second poll and keeps the batch live.
3. **Batch exit.** A pending decision or a live merge wait sets status `waiting` and exit 1.

## Authors

Andro Marces

## Links

- [Issue #1711: Release loop slots on owner decisions, resume after owner merges, and notify](https://github.com/andromarces/agent-loops/issues/1711)
- [PR #1732: Release batch loop slots on owner decisions, resume after merges, and notify](https://github.com/andromarces/agent-loops/pull/1732)
- [Issue #1728: Report paused when another resume holds the lock of a needs-owner batch loop](https://github.com/andromarces/agent-loops/issues/1728)
- [PR #1730: Report paused when a held lock skips a needs-owner loop](https://github.com/andromarces/agent-loops/pull/1730)
- [Issue #1735: State the held-lock paused rule of batch resume in the ADR and link PR #1730](https://github.com/andromarces/agent-loops/issues/1735)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
- [ADR 0117: State the held-lock paused rule and its precedence in batch resume](0117-state-the-held-lock-paused-rule-and-its-precedence.md)
- [ADR 0014: Extend the step budget of a live interactive run](0014-extend-the-step-budget-of-a-live-run.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md)
- [ADR 0045: Gate the finish of a headless run on the PR that its runtime declares](0045-gate-the-finish-on-the-pr-that-the-headless-runtime-declares.md)
- [ADR 0104: Accept a test-slot command as an argument vector](0104-accept-a-test-slot-command-as-an-argument-vector.md)
- [Issue #1710: Coordinate reviewer audits and issue creation](https://github.com/andromarces/agent-loops/issues/1710)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch decisions](../src/batch/decisions.mjs)
- [Implementation: batch notifier](../src/batch/notifier.mjs)
- [ADR Index](README.md)
