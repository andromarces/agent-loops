# 0131. Name the undeclared pull request of a batch loop

## Status

accepted

## Supersedes

This ADR partially supersedes
[adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md).
The replaced parts are decision 8's checkpoint field list, decision 11's reconciliation rule for a recorded pull request, and decision 13's cleanup proof.

- Decision 8's checkpoint adds `prUndeclared`, the pull request that the runtime refused to declare.
- Decision 11 uses the recorded pull request, declared or undeclared, in its checks.
- Decision 13's merged proof reads the declared pull request, or the undeclared one.

This ADR partially supersedes
[adr/0114-report-an-exit-4-loop-as-needs-owner.md](0114-report-an-exit-4-loop-as-needs-owner.md)
decisions 2 and 3. Decision 2's rule applies to `pr` only. A transcript with no declaration now records `prUndeclared`. Decision 3 names a recorded undeclared pull request in the next action.
A loop with no recorded pull request names the branch only when both fields are null.

Every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-12

## Context

On a private repository on the GitHub Free plan, the rulesets endpoints return 403.
The runtime refuses to declare a worker-opened pull request, because the gate refuses every finish ([adr/0053-compare-the-head-of-a-worker-opened-pr-that-the-runtime-refused-to-declare.md](0053-compare-the-head-of-a-worker-opened-pr-that-the-runtime-refused-to-declare.md)).
The batch records a loop's pull request only from a declaration ([adr/0114-report-an-exit-4-loop-as-needs-owner.md](0114-report-an-exit-4-loop-as-needs-owner.md) decision 2).
The summary and checkpoint then hold `pr: null` although the run compared the pull request head.
The cleanup proof and a resume also have no pull request.
[Issue #1899](https://github.com/andromarces/agent-loops/issues/1899) reports 11 loops in two batches with this state.

## Decision

### 1. Record the undeclared pull request

After a child exits, the batch reads the last `pr-undeclared` event of the last attempt.
A `continued` event starts a new attempt, as the report reader does.
A missing, malformed, or non-integer record leaves the field null.
The field is `prUndeclared` and sits beside `pr`.
The declared `pr` field and its meaning stay unchanged.
A declared pull request wins, so `prUndeclared` is null when a declaration exists.

### 2. Keep the field off pull request and review-only loops

A `pr` item already holds its frozen number in `pr`.
A `review-only` loop runs no worker turn, so it records no undeclared pull request.
Both keep `prUndeclared: null`.

### 3. Show the field

Every batch summary loop entry and `batch status` carry `prUndeclared`.
The field sits beside the report, which states a pending check at finish.
An exit 4 loop names the recorded pull request, declared or undeclared, in its next action.

### 4. Use the field for reconciliation

The recorded-pull-request check and the own-pull-request exclusion read `pr` or `prUndeclared`.
A loop whose only recorded pull request is undeclared resumes with no `--pr` and no `--require-ci`.
The finish then keeps the head compare.

### 5. Use the field for the cleanup proof

The merged pull request proof reads `pr` or `prUndeclared`.
Every existing check stays: merged state, local head inside the PR head, and merge commit on `origin/<base>`.

### 6. Read no pull request from GitHub

The batch never reads GitHub to fill the field.
A branch search cannot supply a pull request from another repository.

### 7. Write only on a change

The loop checkpoint is a persistent store.
Every exit path stores the field in the same write as the status.
A no-op run adds no loop record write.

## Consequences

- A batch summary and checkpoint name the pull request on a repository with unreadable required checks.
- `batch status` names the pull request beside the finish report, which can state a pending check.
- The cleanup proof and a resume use the recorded number without a new gate.
- A declared pull request keeps its field and its meaning.
- A no-op run keeps the write cadence of [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md) decision 8.

## Alternatives

1. **Search GitHub by branch to fill the number.** Rejected. A branch search can return a pull request from another repository, and the build adds a read.
2. **Reuse the `pr` field.** Rejected. It changes the declared field's meaning and the finish gate.
3. **Parse the finish summary prose.** Rejected. Prose is not a state, and an unusual line loses the number.

## Authors

Andro Marces

## Links

- [Issue #1899: Name the undeclared pull request of each batch loop on a repository with unreadable required checks](https://github.com/andromarces/agent-loops/issues/1899)
- [Pull request #1903: Name the undeclared pull request of a batch loop](https://github.com/andromarces/agent-loops/pull/1903)
- [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md)
- [adr/0114-report-an-exit-4-loop-as-needs-owner.md](0114-report-an-exit-4-loop-as-needs-owner.md)
- [adr/0053-compare-the-head-of-a-worker-opened-pr-that-the-runtime-refused-to-declare.md](0053-compare-the-head-of-a-worker-opened-pr-that-the-runtime-refused-to-declare.md)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch loop records](../src/batch/loop-records.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Implementation: cleanup proof](../src/batch/cleanup.mjs)
- [Implementation: reconciliation](../src/batch/reconcile.mjs)
- [Implementation: transcript record reader](../src/lib/gate.mjs)
- [Tests: batch outcomes](../tests/batch/supervisor.outcomes.test.mjs)
- [Tests: cleanup](../tests/batch/cleanup.test.mjs)
- [Tests: reconciliation](../tests/batch/reconcile.test.mjs)
- [Tests: transcript record reader](../tests/lib/gate.test.mjs)
- [ADR Index](README.md)
