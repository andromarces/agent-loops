# 0177. Read the undeclared pull request in the batch overlap report

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0176: Report batch pull requests that change the same files](0176-report-batch-pull-requests-that-change-the-same-files.md). The replaced part is decision 1's clause that a loop without an integer pull request number is not read, which leaves a loop whose number sits in `prUndeclared` out of the comparison. Every other decision, consequence, and alternative stays in force.

## Date

2026-11-28

## Context

ADR 0176 decision 1 reads the changed-file list of a pull request only when its loop holds a
declared `pr`. A loop whose worker-opened pull request the runtime refused to declare holds
`pr: null` and the number in `prUndeclared`
([ADR 0131](0131-name-the-undeclared-pull-request-of-a-batch-loop.md)). The merged proof and
`batch status` already take `pr`, else `prUndeclared`.

On a repository whose required checks the gate cannot read, for example a private repository on
the GitHub Free plan, every loop is undeclared. A 2-issue `work-first` batch on 2026-11-27 ended
with both loops `succeeded`, `pr: null`, and `prUndeclared` set. Both pull requests changed one
ADR file, and the summary held `overlapGroups: []` and `overlapIncomplete: []`. A 6-issue batch
on the same day left five pull requests on one handler module and three on `adr/README.md`, and
its summary also held empty lists. A merge of the branches conflicted in the handler module and
its test, and in `adr/README.md`. The overlap was found only by reading the file lists by hand
([issue #2048](https://github.com/andromarces/agent-loops/issues/2048)).

## Decision

1. The overlap read takes the pull request of each succeeded loop as `pr`, else
   `prUndeclared`, the same order that the merged proof and `batch status` use. A value that is
   not an integer in either field is no number.
2. A succeeded loop with neither number is left out of the comparison and named in one warning,
   also when fewer than two numbers remain. The warning never fails the batch.
3. Every other rule of ADR 0176 stays in force: the list proof, the groups, `overlapIncomplete`,
   the repository host, the finalization, and the warning and exit-code behavior.

## Consequences

- A batch whose succeeded loops hold only undeclared pull requests lists their groups in the
  summary and in `batch status`.
- A refused declaration no longer reads as a proved no overlap on a repository whose required
  checks the gate cannot read.
- A succeeded loop that names no pull request number is visible in a warning instead of an empty
  report that reads as no overlap.
- The report still reads at most one file list per pull request, and one pull request still needs
  no read.

## Alternatives

1. **Add the loop key to `overlapIncomplete`.** Rejected. That field holds pull request numbers,
   so a loop key there would read as a pull request.
2. **Fail the batch on a succeeded loop with no number.** Rejected. ADR 0176 keeps a report
   failure out of the batch outcome, and issue #2048 asks for a name, not a failure.
3. **Read only `prUndeclared` and ignore `pr`.** Rejected. A declared number wins at the merged
   proof and at `batch status`, so it must win here.

## Links

- [Issue #2048: Include undeclared pull requests in the batch overlap report](https://github.com/andromarces/agent-loops/issues/2048)
- [PR #2050: Read the undeclared pull request in the batch overlap report](https://github.com/andromarces/agent-loops/pull/2050)
- [ADR 0176: Report batch pull requests that change the same files](0176-report-batch-pull-requests-that-change-the-same-files.md)
- [ADR 0131: Name the undeclared pull request of a batch loop](0131-name-the-undeclared-pull-request-of-a-batch-loop.md)
- [Implementation: changed-file groups](../src/batch/overlap.mjs)
- [Tests: changed-file groups](../tests/batch/overlap.test.mjs)
- [Tests: batch outcomes](../tests/batch/supervisor.outcomes.test.mjs)
- [ADR Index](README.md)
