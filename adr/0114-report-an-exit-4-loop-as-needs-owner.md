# 0114. Report an exit 4 batch loop as needs-owner

## Status

accepted

## Supersedes

This ADR partially supersedes
[adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md).
The replaced parts are the exit 4 rule of decision 10 and the exit 4 part of decision 12.

- Decision 10's sentence "A loop that ended 1, 2, or 4 is `failed`" now applies to exit 1 and exit 2 only.
- Decision 12's sentence that a loop ending on a nonzero headless exit is `failed` now excludes exit 4.

Every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-09

## Context

A headless run exits 4 when its finish records an unresolved PR-head compare (`UNRESOLVED_COMPARE_EXIT` in `src/runtime.mjs`). The run finished and printed its full summary, but the runtime did not verify that the pull request head equals the reviewed commit.

The batch marked that loop `failed` with reason `exit-4` and released its claim, in `finishChild` and in the recovery path of `src/batch/supervisor.mjs`. Decision 10 and decision 12 of `adr/0106-foreground-batch-scheduling.md` state that rule. The owner then saw a failure, the claim was free for a later batch, and no step checked the head again (issue #1739).

## Decision

### 1. One stop step reports exit 4 as needs-owner

Both the normal end path and the recovery path call one shared step for exit 4. It marks the loop `needs-owner` with reason `pr-head-unresolved` through `markNeedsOwner`. That path creates the pending decision, so `adr/0110-release-batch-slots-on-owner-decisions.md` still owns the decision protocol. No second way to enter `needs-owner` is added.

The loop keeps its claim and its work tree. The exit 4 path runs no cleanup and no `releaseClaim`.

### 2. The step records the declared pull request

The recovery path reads the pull request with `declaredPrFromTranscript`. The normal end path reads the same function from the transcript. The step records the number on the loop.

A transcript that declares no pull request leaves the number unset. `batch status` then names the branch and states that the pull request number is not recorded.

### 3. `batch status` names the pull request and the next action

The loop entry carries a `nextAction` for reason `pr-head-unresolved`. It names the pull request and states: compare its head with the reviewed commit, then merge or resume. With no recorded pull request, it names the branch and states that the number is not recorded.

### 4. Every option of the decision works

The decision offers the normal `resume` and `abandon` options. `abandon` ends the loop as failed and releases its claim. `resume` returns the loop to the queue.

On resume, an applied `resume` answer skips the exit 4 stop and runs the existing reconciliation. A merged pull request that holds every local commit ends the loop `succeeded`. An unresolved or ambiguous head stops the loop `needs-owner` again, with the reconciliation reason.

A new attempt clears the applied answer, so a later exit 4 is a new stop with its own decision. A repeated recovery of the same unanswered state reuses its decision and writes no checkpoint.

### 5. The batch exit code and notification stay unchanged

A `needs-owner` loop keeps the batch exit code at 1 through `exitCodeOf`. The batch status is `waiting`, so it sends no completion notification while the decision is pending. The existing waiting poll reapplies an answer.

### 6. Documentation and tests

The implementation updates `docs/reference/usage.md`, `docs/reference/architecture.md`, `docs/orchestrator-instructions.md`, and the batch help text. The tests in `tests/batch/supervisor.test.mjs` cover both paths, the status text, exit 1 and exit 2 as failed, and a resume after an exit 4 stop.

## Consequences

- An owner sees an exit 4 loop as a finished loop that needs one check, not as a failure.
- The claim stays, so a later batch cannot select the issue while its pull request is open.
- The decision protocol of `adr/0110-release-batch-slots-on-owner-decisions.md` applies unchanged.
- A pending exit 4 decision keeps no loop slot once no recorded child process is live.

## Alternatives

1. **Keep exit 4 as failed.** Rejected. The run finished, and only the head compare is unverified.
2. **Release the claim and report success.** Rejected. An unverified head is not a verified finish.
3. **Add a second needs-owner path.** Rejected. `markNeedsOwner` already creates the decision and keeps the claim.

## Links

- Issue #1739
- `adr/0106-foreground-batch-scheduling.md`
- `adr/0110-release-batch-slots-on-owner-decisions.md`
