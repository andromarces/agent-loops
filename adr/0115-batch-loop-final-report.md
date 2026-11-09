# 0115. Report each loop's final report in the batch summary

## Status

accepted

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
2. The report holds `summary`, `error`, `failedTurnTest`, `warnings`, and `transcriptRead`. A loop with no finish shows `summary: null`.
3. `summary` comes from the last `finish` action event of the last attempt. The five base keys stay required, and `notes` is optional. A missing `notes` key reads as `null`.
4. `error` comes from the transcript `error` field. `failedTurnTest` comes from a fatal `test-run` event. Both describe the last attempt.
5. The headless run records each delete-by-hand warning in a transcript `warnings` list. The log line text stays unchanged.
6. A retried loop reuses one transcript. Events before the last `continued` event belong to an earlier attempt and never enter the report.
7. The batch reads the transcript once when a loop ends, in the normal end path and in the recovery path. It stores the report in the same checkpoint write as the status change.
8. `batch start`, `batch resume`, and `batch status` read `report` from the checkpoint store. `batch status` never reads the transcript again.
9. A missing, unreadable, truncated, or malformed transcript fails closed. The report then holds `transcriptRead: {ok: false, reason}` and null summary, error, failed-turn test, and warnings. No field reads as "none".
10. Every copied summary, error, failed-turn test, and warning text is redacted at the reporting boundary. A warning list keeps at most 20 entries.
11. The headless `SUMMARY` block prints a `Notes` line. A finish without notes prints `Notes: none`.
12. The child prompt carries reviewer `Notes` into `notes`. It carries Blockers into `open`, and Deferred items into `deferred`.

## Consequences

- A parent that starts a batch reads each loop outcome from one JSON object.
- A loop with no finish reports a null summary, so a reader never sees an absent finish as a failed one.
- An unread transcript reports an unread state, so a reader never sees it as no warnings or no error.
- A retried loop reports only its last attempt.
- A report adds no store write beyond the status change write.
- The five-key finish summary stays valid on the headless path and the interactive path.
- Reviewer notes no longer read as open findings.

## Links

- [Issue #1737: Report each loop's final report in the batch summary](https://github.com/andromarces/agent-loops/issues/1737)
- [adr/0106-foreground-batch-scheduling.md](0106-foreground-batch-scheduling.md)
- [Implementation: batch loop report](../src/batch/report.mjs)
- [Implementation: batch supervisor](../src/batch/supervisor.mjs)
- [ADR Index](README.md)
