# 0034. Keep the Codex reviewer descendant gap after a parent end

## Status

proposed

## Date

2026-10-10

## Context

Issue #712 (probe of issue #692, ADR 0027) found a late write by a Codex reviewer command. A `--reviewer-workspace-write` reviewer turn ran the committed script `sh ./check.sh` (`sleep 90`, then `echo ORPHAN > orphan-write-rev.txt`). The write landed 52 s after the `SIGTERM` of the headless parent, after a clean `git status` from the reviewer and from the driver. The mutation check reported no tree state, because the turn did not return (ADR 0027, probe of issue #692).

The issue leaves three options open: leave no such command after a parent end, detect it before the next turn, or record why the gap stays. The facts of the probe and of the code that bear on the choice:

- The `SIGKILL` of the first parent ended all 12 recorded descendants within 1.5 s. The first Codex thread holds `turn_aborted`, and no write came from it. The writer was a command of the second thread, which the continued run started itself. The `SIGTERM` came after that, and the host record does not show whether the Codex process survived it (checklist item for issue #708).
- The runtime handles `SIGINT` only (ADR 0033, `cancelOnSigInt`). A `SIGTERM` has no handler, so Node ends the parent at once and no cleanup runs.
- `SIGKILL` has no handler in any process. No parent code can end children on it.
- The Codex adapter pre-assigns no id. It reads `thread_id` from the `thread.started` event of the output (`src/agents/codex.mjs`). A killed first turn can leave no id in the transcript, so a session-flag check as in ADR 0031 and ADR 0032 has no id to match.
- ADR 0032 found no working-directory property in the Windows process table, and the POSIX tools (`/proc/<pid>/cwd`, `lsof -d cwd`) are not verified. A match by work tree is not available.
- The write came from a script that the sandbox allows by operator choice (ADR 0019, opt-in `--reviewer-workspace-write`), not from a model decision.
- The host of this change is Windows. Windows has no `SIGTERM` delivery through `kill` (ADR 0033 decision 9), and the Codex probe ran on macOS only.

## Decision

1. The runtime adds no behavior for a Codex reviewer descendant that outlives its parent. The gap stays. This decision follows ADR 0031 decision 7 and ADR 0032 decision 4, which also leave the gaps that need a process that the runtime did not start in this run.
2. The runtime does not add a `SIGTERM` handler that ends the child trees on this evidence. The cause is not verified: whether the Codex process or only its shell children survived the `SIGTERM` is open in issue #708. A handler cannot cover `SIGKILL`. The Windows host cannot test the signal, so a test there would assert a path that never runs.
3. The runtime does not detect such a command before a turn. Codex has no pre-assigned id to match, and no verified work-tree match exists (ADR 0032, alternative 1). A bare process-name match would refuse a run for any unrelated `codex` or `sh` process on the host.
4. The operator rule is stated in the README. After a parent of a `--reviewer-workspace-write` run ends by a signal other than `SIGINT`, the operator checks for a surviving `codex` process or shell child and the state of the work tree before the next run.
5. The decision has no test, because the code does not change. The acceptance allows this: the ADR records why the gap stays.

## Consequences

- A write from a descendant of a Codex reviewer turn can land after the parent ends, after a clean tree report, and the runtime reports nothing for it. The operator sees it only by a check of the process table and of the tree.
- A run of read-only reviewer turns is not affected. The sandbox of those turns blocks writes (ADR 0019).
- Reopen this decision when one of these holds:
  - The macOS check of issue #708 shows that a Codex process survives a `SIGTERM` with no continued run. A `SIGTERM` handler that calls `killLiveTrees` (ADR 0033) is then the least-expansive fix, and it can be tested on POSIX only.
  - Codex gains a pre-assigned or pre-read session id, so a flag check can find the holder.
  - A verified call exposes the working directory of a process on Windows and POSIX.
- Not verified: a Codex reviewer that chooses to write, a write-capable Claude orchestrator, Linux, and the cause of the first-run descendants ending with the `SIGKILLed` parent.

## Alternatives

1. **End the child trees on `SIGTERM`**: rejected for now. The cause is unverified (issue #708), the signal cannot be tested on this host, and `SIGKILL` stays uncovered.
2. **Detect a holder by the Codex thread id**: rejected. The id is read from the output, and a killed turn does not leave it.
3. **Detect a holder by work tree or by process name**: rejected. No verified work-tree match exists, and a name match refuses unrelated processes.
4. **Add a lock file or a registry of live reviewer children**: rejected. A hard kill leaves a stale entry, and ADR 0020 shows that it needs a liveness check. ADR 0032 decision 4 rejects a new store for the same reason.
5. **End the surviving process on the next run**: rejected by ADR 0031 decision 7. The runtime would signal a process that it did not start in this run.

## Authors

Andro Marces

## Links

- [Issue #712](https://github.com/andromarces/agent-loops/issues/712)
- [Issue #692](https://github.com/andromarces/agent-loops/issues/692)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [ADR 0019: Opt-in workspace-write sandbox for the Codex reviewer](0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- [ADR 0031: Refuse --continue-from and --resume-interrupted while a live process holds a Claude session](0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md)
- [ADR 0032: Detect a live session holder on interactive init, keep the headless gap](0032-detect-a-live-session-holder-on-interactive-init.md)
- [ADR 0033: Cancel a run on SIGINT and escalate on a second SIGINT](0033-cancel-a-run-on-sigint-and-escalate-on-a-second-sigint.md)
- Implementation: none. Documented in `README.md`.
- [ADR Index](README.md)
