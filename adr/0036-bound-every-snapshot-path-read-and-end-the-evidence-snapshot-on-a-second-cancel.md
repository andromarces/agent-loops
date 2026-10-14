# 0036. Bound every snapshot-path read and end the evidence snapshot on a second cancel

## Status

accepted

Partially supersedes [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md): decision 8, which drops the snapshot of the turn on a second SIGINT, no longer holds for the evidence snapshot. Decision 3 gains the deferral of decision 4 below while that snapshot runs.

## Date

2026-10-11

## Context

Issue #729 found child-process reads with no time bound and no cancel. A stuck `git` or `ps` child hung the caller. The reads were the process-table readers, the snapshot `git` calls, the `--cwd` probe, and the local-files `git` calls.

A canceled turn needs one read that must still run. The after-turn and after-command snapshots record the changed paths, and the cancel outcome is exit 130. A cancel signal that aborts that read loses the evidence. A read with no cancel can hang the exit.

## Decision

1. One bounded runner, `execBounded` in `src/lib/exec.mjs`, runs `gh`, `git`, and the process-table reads. It sets a time bound, a cancel signal, and the process-tree kill. It returns the raw result and never throws for an exit code, so each caller keeps its own contract.
2. Each read has a bound. A snapshot `git` read and the `--cwd` probe end after 120 s. A local-files `git` read ends after 60 s. A process-table read ends after 30 s. The `wait-checks` probe ends at the command bound.
3. Every read honors the cancel signal of the run, except the evidence snapshots. A canceled read rejects with `isCanceled` set, so the caller keeps exit 130. A canceled continuation gate rejects as a cancel and never reads as a missing gate.
4. The evidence snapshots ignore the first cancel and honor the second. `cancelOnSigInt` aborts `forceCancelSignal(signal)` on the second SIGINT. While an evidence snapshot runs, the exit with code 130 waits until the run removes its SIGINT listener, after the transcript and envelope writes. A hard exit after 5 s is the fallback. A third SIGINT exits at once.
5. A second cancel never reports the tree as unchanged. `withMutationCheck` throws a canceled `SnapshotError` that says the evidence was not captured. `runTestCmd` keeps the status of a command that finished before the cancel, and sets `workTreeChanged` and `changedCount` to `null`.
6. The headless run keeps the reason in the transcript and the error report as `Interrupted by SIGINT: <reason>`. The interactive path keeps it in the envelope.

## Consequences

- No snapshot-path read can hang a run, and a cancel ends each one except the evidence snapshot.
- A second SIGINT during an evidence snapshot delays the exit by the time the run needs to write its result, up to 5 s.
- A consumer reads `null` in `workTreeChanged` as not captured. It never reads it as no change.
- A process-table read now has a cancel path. `harness-check` exits 130 on a cancel.
- Verified by tests with a hung `git` and a hung `ps` shim, and with real SIGINT runs of the CLI on POSIX. A real Windows console is not verified.

## Alternatives

1. **Honor the first cancel in the evidence snapshot**: rejected. It loses the changed paths of a canceled turn.
2. **Exit at once on the second SIGINT**: rejected. The exit then cuts the not-captured result before the transcript and the envelope hold it.
3. **A bound only for the evidence snapshot**: rejected. A second cancel must be able to end a hung read before the bound.

## Authors

Andro Marces

## Links

- [Issue #729: Bound every process-table read and git call in the snapshot path](https://github.com/andromarces/agent-loops/issues/729)
- [Pull request #743](https://github.com/andromarces/agent-loops/pull/743)
- Partially supersedes [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md) (decision 8)
- [ADR 0017: Run a test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR 0028: End the Windows process tree of a child when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- Implementation: `execBounded` in `src/lib/exec.mjs`, `forceCancelSignal` and `beginEvidenceRead` in `src/lib/sigint.mjs`, `withMutationCheck` in `src/lib/snapshot.mjs`, and `runTestCmd` in `src/lib/test-cmd.mjs`.
- [ADR Index](README.md)
