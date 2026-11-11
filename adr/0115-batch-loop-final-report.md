# 0115. Report each loop's final report in the batch summary

## Status

partially-superseded

## Superseded by

[adr/0126-keep-review-only-reviewer-items-in-separate-report-fields.md](0126-keep-review-only-reviewer-items-in-separate-report-fields.md) partially supersedes this ADR. The replaced parts are decision 2's report field list and decision 11's cap rule for copied values. Decisions 1, 3 to 10, 12, and 13 stay in force, and so does decision 11's redaction rule. Every other consequence and acceptance check stays in force.

## Supersedes

This ADR partially supersedes [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md). The replaced part is decision 1's summary field list. Every other decision, consequence, and acceptance check stays in force.

## Date

2026-11-09

## Context

The batch summary reports each loop status, reason, pull request, step counts, cleanup result, log, and transcript. It does not report the finish summary, the failure cause, the failed-turn test result, or the delete-by-hand warnings. A parent that starts a batch must read each log and transcript to act on a loop.

A single headless run already records its finish summary, error, and failed-turn evidence in its transcript. The batch reads that transcript for step counts, but it copies no report into the loop entry.

Reviewer `Notes` reach only `open`, and a note then reads as an unresolved finding. No rule carries a note into a distinct summary field.

## Decision

1. Each loop entry carries one `report` object. The batch summary stays one JSON object with one report per loop.
2. The report holds `state`, `summary`, `error`, `failedTurnTest`, `warnings`, `warningsOverflow`, and `transcriptRead`. A loop with no finish shows `summary: null`.
3. `state` is `read`, `no-attempt`, `unread`, or `missing`. `warningsOverflow` counts the warnings outside the 20-entry cap.
4. `summary` comes from the last `finish` action event of the last attempt. The five base keys stay required, and `notes` is optional. A missing `notes` key reads as `null`.
5. `error` comes from the transcript `error` field. `failedTurnTest` comes from a fatal `test-run` event. Both describe the last attempt.
6. The headless run records each delete-by-hand warning in a transcript `warnings` list. The log line text stays unchanged.
7. A retried loop reuses one transcript. Events before the last `continued` event belong to an earlier attempt and never enter the report.
8. The batch reads the transcript once when a loop ends, in the normal end path and in the recovery path. It stores the report in the same checkpoint write as the status change.
9. `batch start`, `batch resume`, and `batch status` read `report` from the checkpoint store. `batch status` never reads the transcript again.
10. A missing, unreadable, truncated, or malformed transcript fails closed. The report then holds `transcriptRead: {ok: false, reason}` and null summary, error, failed-turn test, and warnings. No field reads as "none".
11. Every copied summary, error, failed-turn test, and warning text is redacted. A warning list keeps at most 20 entries and counts the rest in `warningsOverflow`.
12. The headless `SUMMARY` block prints a `Notes` line. A finish without notes prints `Notes: none`.
13. The child prompt carries reviewer `Notes` into `notes`. It carries Blockers into `open`, and Deferred items into `deferred`.

## Consequences

- A parent that starts a batch reads each loop outcome from one JSON object.
- A loop with no finish reports a null summary, so a reader never sees an absent finish as a failed one.
- An unread transcript reports an unread state, so a reader never sees it as no warnings or no error.
- A stored loop without a report reads as missing, never as a clean loop.
- A capped warning list names its overflow count.
- A retried loop reports only its last attempt.
- A report adds no store write beyond the status change write.
- The five-key finish summary stays valid on the headless path and the interactive path.
- Reviewer notes no longer read as open findings.

## Links

- [Issue #1737: Report each loop's final report in the batch summary](https://github.com/andromarces/agent-loops/issues/1737)
- [PR #1742: Report each loop's final report in the batch summary](https://github.com/andromarces/agent-loops/pull/1742)
- [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md)
- [Implementation: batch loop report](../src/batch/report.mjs)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [Implementation: batch status](../src/batch/status.mjs)
- [Implementation: finish summary contract](../src/contracts/orchestrator-action.mjs)
- [Implementation: headless SUMMARY block](../src/cli.mjs)
- [Implementation: transcript warnings](../src/lib/transcript.mjs)
- [Implementation: run warning collector](../src/lib/run-warnings.mjs)
- [Implementation: turn directory warning](../src/lib/turn-tmpdir.mjs)
- [Implementation: reviewer scratch warning](../src/lib/reviewer-scratch.mjs)
- [Tests: batch loop report](../tests/batch/report.test.mjs)
- [Tests: batch report store write](../tests/batch/supervisor.report-write.test.mjs)
- [ADR Index](README.md)
