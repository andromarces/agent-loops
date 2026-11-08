# 0109. Release batch loop slots on owner decisions, resume after merges, and notify

## Status

accepted

## Supersedes

This ADR partially supersedes
[ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md).
These parts of ADR 0106 are replaced:

- Decision 1's return rule. The foreground command also returns with status `waiting` when a
  pending decision needs the owner.
- Decision 5's sentence that a `needs-owner` loop keeps its slot. A loop that becomes a pending
  decision releases its slot, and the next eligible issue takes it.
- Decision 6's `blocked` skip. A blocked issue waits and is polled, and it launches after its
  blockers close. It is not a final skip.
- Decision 16's deferred in-batch decision request, slot release, owner-merge continuation, and
  desktop notifications. ADR 0109 provides all four.
- The consequence that a `needs-owner` loop holds a slot until milestone 3, and the milestone 1
  standalone sentence that a loop needing an owner decision or a merge holds one slot.

Every other decision, consequence, and acceptance check of ADR 0106 stays in force. The batch
still never merges, approves, comments on, labels, force-pushes, resets, or deletes a branch.

## Date

2026-11-09

## Context

ADR 0106 runs one foreground batch of headless loops. A loop that stops as `needs-owner` keeps
its slot, because milestone 1 has no answer path. A selected issue that an open issue blocks is
a final skip, so the owner starts a new batch after the blocker closes. The owner sees neither
event without reading `batch status`.

Milestone 3 needs four capabilities. A loop releases its slot while it waits for an owner
decision. The owner answers one decision by its id and one option. A blocked issue resumes in
the running batch after its blockers close. A desktop notification announces a new decision, a
required merge, and batch completion on macOS and Windows.

The accepted ADR 0106 already fixes claims, checkpoints, budgets, gates, and cleanup. This ADR
composes those rules and changes only the slot, blocking, answer, and notification behavior.

## Decision

### 1. A `needs-owner` loop becomes a pending decision and releases its slot

Every transition that ADR 0106 records as `needs-owner` now creates a pending decision. The
decision holds a unique id, the issue, the reason, the evidence, two or more option keys, and one
recommended option. The id is `<batch id>-issue-<issue>-<attempt>-<reason hash>`, so it is
unique across batches and stable for one state.

The loop checkpoint keeps the decision id in `decision`. A later `needs-owner` transition with
the same reason reuses that pending decision. A changed reason creates a new decision, because the
old evidence no longer describes the loop.

A loop with a pending decision is not terminal. The batch counts it as no live slot, so the next
eligible issue launches in the freed slot. The loop keeps its claim, work tree, transcript, and
remaining step budget, as ADR 0106 decision 7 states for `needs-owner`.

The two fixed options are `resume` and `abandon`. `resume` is recommended. `resume` returns the
loop to the queue after the owner resolves the local or remote state. `abandon` ends the loop as
`failed` with reason `owner-abandoned`, releases its claim, and keeps its work tree.

### 2. The answer command binds one option to one decision

The new command is:

```bash
agent-loop batch answer --batch <id> --decision <decision id> --option <key>
```

The answer is bound to that batch id and that decision id only. The command refuses an unknown
batch, an unknown decision, a decision of another batch, an answered decision, and an option that
the decision does not list. A refusal exits 2 and writes nothing.

A malformed decision file, a malformed answer file, and a loop checkpoint that does not name the
decision each exit 1 and write nothing. The reader never guesses a missing option or a partial
record.

A successful answer prints one JSON object on stdout and exits 0. `resume` sets the loop
checkpoint to `queued`. `abandon` sets it to `failed` with reason `owner-abandoned` and releases
the claim.

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

### 4. A resume answer returns the loop to the queue with the remaining budget

`batch resume` reads the pending decision first. A pending decision with no answer keeps its
`needs-owner` status, stays pending, holds no slot, and is reported again. A malformed decision
or answer keeps the loop `needs-owner` and logs a warning. The resume never guesses an answer.

An answer with `abandon` ends the loop as `failed` and releases its claim. An answer with
`resume` sets the loop `queued`, and the normal recovery path re-checks the recorded state.

The resumed attempt keeps the remaining step budget rules of ADR 0106 decision 10. It continues
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

The notifier bounds the text length and removes control characters. It bounds the process time
and ends only its own child on the bound. A missing binary, a non-zero exit, and a timeout log a
warning. A notification never fails or stalls the batch.

Tests inject the notifier and a clock. A test passes quotes, backticks, `$()`, `%`, newlines, and
non-ASCII text through the argument vector that the notifier builds.

### 7. A pending decision or merge wait survives an interrupted session

A pending decision and a `waiting` issue are checkpoint states. `batch resume` reads both. It
keeps a pending decision pending and keeps its slot free. It re-checks a waiting issue on the
same poll interval and launches it after its blockers close.

The batch status `waiting` covers both cases. The command exits 1, and no completion notification
is sent while either state remains. The owner answers a decision or merges a blocker, and runs
`batch resume` only when the batch is not live.

### 8. `batch status` shows the decision and wait details

Each loop entry of `batch status` carries `decision`, `blockingIssues`, and `requiredMerges`.
`decision` holds the id, reason, evidence, option keys, recommendation, answer, and state. The
state is `pending`, `answered`, or `malformed`.

The batch entry carries `completion: { status, complete }`. `complete` is true only for the
statuses `completed` and `failed`. `batch status` writes nothing.

### 9. Documentation for milestone 3

The implementation updates the batch text of `docs/reference/usage.md`,
`docs/reference/architecture.md`, `docs/orchestrator-instructions.md`, and `src/help.mjs`. The
orchestrator instructions replace only the sentence that defers decisions, slot release, and merge
continuation. README and onboarding expansion stay out of scope.

### 10. Acceptance checks for milestone 3

The implementation passes these checks:

1. A pending decision frees its slot, and the next eligible issue launches in it.
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

1. **Keep the slot while a loop waits for a decision.** Rejected. It is the ADR 0106 behavior
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

1. **Decision options.** Every pending decision offers `resume` and `abandon`, and recommends
   `resume`.
2. **Blocked wait.** A blocked issue waits on a 15-second poll and keeps the batch live.
3. **Batch exit.** A pending decision or a live merge wait sets status `waiting` and exit 1.

## Authors

Andro Marces

## Links

- [Issue #1711: Release loop slots on owner decisions, resume after owner merges, and notify](https://github.com/andromarces/agent-loops/issues/1711)
- [ADR 0106: Run several issue loops in one foreground batch](0106-foreground-batch-scheduling.md)
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
