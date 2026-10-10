# 0029. Refuse --continue-from while a live process holds a Claude session

## Status

accepted

## Date

2026-10-10

## Context

After a `SIGKILL` of the headless parent, the `claude` child of a worker turn stays alive with parent pid 1 and runs the turn to its end (ADR 0027, probe of issue #627). `--continue-from` then resumes the same session id, and the CLI prints no error. Two live processes write one session file, and the orphan can write to the work tree after the continued reviewer reports a clean tree (issue #647).

The adapter matches `Error: Session ID <id> is already in use.` only on a failed first turn. The code holds no check for a live holder of a resumed session.

## Decision

1. `--continue-from` refuses to start when another live process names the session id of a Claude role in its command line. `refuseHeldSessions` in `src/lib/continuation.mjs` runs after `restoreSessions` and before any turn. The error names the role, the id, and the pid. The exit code is 1. The run writes no transcript, as for every other refusal of `--continue-from`.
2. The check reads the process table once per run, with `readProcessCommands` in `src/lib/process-ancestry.mjs`: `ps -eo pid=,command=` on macOS and Linux, and `Get-CimInstance Win32_Process` on Windows. Both are the mechanisms of the existing harness detection. A first turn passes the id with `--session-id` and a resumed turn passes it with `--resume`, so a holder of either kind carries the id.
3. The check covers a Claude role whose id is a canonical UUID. A shorter id would match unrelated command lines. The process of the runtime is excluded.
4. A process table that cannot be read logs a warning and lets the run continue. A refusal on that failure would block every `--continue-from` on a host without `ps` or PowerShell.
5. The runtime does not wait for the holder and does not end it. A wait has no bound that fits an orphan whose turn length is unknown. An end signal would act on a process that the runtime did not start in this run, and ADR 0017 item 4 rejects that class of action. The operator ends the process or waits for it, and runs again.

## Consequences

- The reproduction of issue #647 now ends with exit 1 and a named holder, before any turn. The orphan is left alone.
- A process that carries the id in its command line for another reason also refuses the run, for example a shell that runs `claude --resume <id>`. The error names the pid, so the operator can inspect it. The refusal is the safe side.
- A holder that does not carry the id in its command line is not found. The check also does not cover a fresh run in the same work tree, because a fresh run holds no earlier id. An orphan from an earlier run can still write to that tree.
- The check does not run for the orchestrator or the reviewer of another CLI. Only the Claude orphan is observed (ADR 0027), so the other adapters are not verified to leave one.
- The check and the resume are not atomic. A holder that starts between them is not found.
- The check costs one process-table read per continued run. On Windows, this is one PowerShell start.
- Verified on macOS 27.2 (arm64), Node v26.11.1, Claude Code 2.1.296, with `haiku` in a probe repository under the temporary directory. A real `claude -p --session-id <id>` child that ran a 40 s `Bash` call was found by `refuseHeldSessions` while alive, and was not found 1.5 s after `SIGKILL`. A full reproduction with an orphan of a killed runtime and a continued run is not repeated. Linux and Windows are not run. The Windows command is not run on a Windows host.

## Alternatives

1. **Wait for the holder**: rejected. The turn length of an orphan is unknown, and the run would hang on a stuck process.
2. **End the holder first**: rejected. The runtime would signal a process it did not start in this run, and a pid match on a command line can hit an unrelated process.
3. **Check on every resumed turn, in the adapter**: rejected. A resume inside one run follows a turn of the same run that has ended. The orphan appears only after a parent crash, so one check before the first turn covers it, and the check costs a PowerShell start per turn on Windows.
4. **A lock file per session id**: rejected. A hard kill leaves a stale lock, and ADR 0020 shows that a claim file needs a writer liveness check. The CLI owns the session file, so a lock of the runtime cannot stop its writers. The process table already answers the question.
5. **Use the transcript and `kill(pid, 0)` with a recorded child pid**: rejected. The transcript holds no child pid, and a pid can be reused.

## Authors

Andro Marces

## Links

- [Issue #647](https://github.com/andromarces/agent-loops/issues/647)
- [Issue #627](https://github.com/andromarces/agent-loops/issues/627)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- Implementation: `refuseHeldSessions` in `src/lib/continuation.mjs`, `readProcessCommands` in `src/lib/process-ancestry.mjs`, and the call in `src/cli.mjs`. Documented in `README.md`.
- [ADR Index](README.md)
