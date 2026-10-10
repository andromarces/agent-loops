# 0029. Refuse --continue-from while a live process holds a Claude session

## Status

superseded

Superseded by: [ADR 0031: Refuse --continue-from and --resume-interrupted while a live process holds a Claude session](0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md)

## Date

2026-10-10

## Context

After a `SIGKILL` of the headless parent, the `claude` child of a worker turn stays alive with parent pid 1 and runs the turn to its end (ADR 0027, probe of issue #627). `--continue-from` then resumes the same session id, and the CLI prints no error. Two live processes write one session file, and the orphan can write to the work tree after the continued reviewer reports a clean tree (issue #647).

The adapter matches `Error: Session ID <id> is already in use.` only on a failed first turn. The code holds no check for a live holder of a resumed session.

## Decision

1. `--continue-from` refuses to start when another live process names the session id of a Claude role in its command line. `refuseHeldSessions` in `src/lib/continuation.mjs` runs after `restoreSessions` and before any turn. The error names the role, the id, and the pid. The exit code is 1. The run writes no transcript, as for every other refusal of `--continue-from`.
2. The check reads the process table once per run, with `readProcessCommands` in `src/lib/process-ancestry.mjs`: `ps -eo pid=,command=` on macOS and Linux, and `Get-CimInstance Win32_Process` on Windows. Both are the mechanisms of the existing harness detection, but the read runs through `exec`. The read is bounded at 30 seconds, and a stall warns and lets the run continue (decision 4). On POSIX, a process that ignores SIGTERM ends about 5 seconds later, at the force-kill delay of execa, so the read ends at about 35 seconds at most. The read also ends on the cancel signal of the run, and a cancel is not a warning. It ends the run before any turn. The exit code is 130. The run keeps its SIGINT listener until the run ends, so the exit handler of execa finds another listener and does not re-raise the signal. Decision 8 covers a second SIGINT ([issue #669](https://github.com/andromarces/agent-loops/issues/669)). A first turn passes the id with `--session-id` and a resumed turn passes it with `--resume`, so a holder of either kind carries the id.
3. The check covers a Claude role whose id is a canonical UUID. A shorter id would match unrelated command lines. The process of the runtime is excluded.
4. A process table that cannot be read, or that is not read within the bound, logs a warning and lets the run continue. A refusal on that failure would block every `--continue-from` on a host without `ps` or PowerShell.
5. The interactive `agent-loop role dispatch` path is not covered. See Consequences.
6. A failed read reports its reason class only: timeout, cancel, exit code, signal, spawn failure, or output that is not JSON. `ProcessReadError` carries no output of the read, and the warning prints only its reason. The process table holds the command lines of every process on the host, and those lines can carry the secrets of other programs. No error, warning, or log line holds process-table text.
7. The runtime does not wait for the holder and does not end it. A wait has no bound that fits an orphan whose turn length is unknown. An end signal would act on a process that the runtime did not start in this run, and ADR 0017 item 4 rejects that class of action. The operator ends the process or waits for it, and runs again.
8. A second SIGINT escalates and does not abandon the run (`cancelOnSigInt` in `src/lib/sigint.mjs`). The first SIGINT aborts the run signal. The second, in this order: force-kills the process tree of every live child, writes the transcript or envelope that the run holds, and exits with code 130. The kill is SIGKILL to the process group on POSIX, and `taskkill /pid <pid> /T /F` with `spawnSync` on Windows (`killLiveTrees` in `src/lib/exec-tree.mjs`, ADR 0028). It reaches each child that `killTreeOnExit` records: `exec`, `runGh`, `assertGitWorkTree`, and the test command. `src/cli.mjs` writes the transcript with `exitCode` 130, the error `Interrupted by SIGINT`, the events and session ids that the run holds, by a synchronous temp-file write and rename (`writeFileAtomicSync`). `src/role.mjs` writes one error envelope with the same error.
   - The second SIGINT keeps: a SIGKILL to each recorded child. Exit code 130. An earlier transcript stays whole, because the write is a rename. A file symlink at the transcript path, dangling or not, keeps its link and the write lands at its final target, as in the async write. A transcript that names the `--continue-from` file is replaced as in a normal exit.
   - Kill failures. `killLiveTrees` never throws and goes on to the next child. On POSIX, a SIGKILL that execa does not deliver (it returns `false`) logs a `warn` line with the pid. On Windows, a failed or timed-out `taskkill` logs a `warn` line, and exit code 128 (no process has the pid) logs `debug` only, because `taskkill /T` does not find the descendants of a root that already exited. In each case the child can survive, so "no recorded child outlives the runtime" holds only when the kill is delivered. A child outside the recorded set (the `copilot` launcher and the `git` calls of `src/lib/local-files.mjs`) and an orphan that left the process group can also survive (ADR 0017 item 4, ADR 0028 item 4).
   - Envelope of `role`. One guard serves the normal path and the second SIGINT, so stdout holds at most one envelope. If no envelope write has started, the second SIGINT writes the cancel envelope with `writeSync` in a loop that continues after a partial write and retries `EAGAIN` for at most 2 s. That envelope is shorter than `PIPE_BUF`, so a pipe takes it whole or not at all. A failure before any byte is written (for example `EPIPE` on the first call) logs an error and writes no envelope. A permanent error after a partial write (for example `ENOSPC` on a file or a full disk) logs an error and leaves the bytes already written, a truncated envelope, on stdout, and the exit is still 130. The 2 s limit on `EAGAIN` ends the same way. If the normal write is in flight, the second SIGINT writes nothing and the exit waits for that write for at most 2 s, then exits 130, so a consumer that does not read stdout can leave that one envelope cut. If the write is done, the exit follows at once.
   - Transcript write failures. A write that fails (a full disk, a symlink loop that fails with `ELOOP`, or a Windows rename that a reader blocks, with no retry) logs an error, writes no transcript, and still exits 130. A write that stalls in the OS blocks the exit, because a synchronous call has no bound.
   - The second SIGINT drops: the mutation check and snapshot of the turn, the `gate` event, the summary, and the state-file writes of `role`. The async removal of the session record is skipped, so a stale record stays, and it no longer matches the digest of the new transcript.
   - Windows has no SIGINT delivery through `kill`, so the real-signal tests run on POSIX CI only. The Windows path of `killLiveTrees` has a test that runs here. A Ctrl-C from a real Windows console is not verified.

## Consequences

- The reproduction of issue #647 now ends with exit 1 and a named holder, before any turn. The orphan is left alone.
- A process that carries the id in its command line for another reason also refuses the run, for example a shell that runs `claude --resume <id>`. The error names the pid, so the operator can inspect it. The refusal is the safe side.
- A holder that does not carry the id in its command line is not found. The check also does not cover a fresh run in the same work tree, because a fresh run holds no earlier id. An orphan from an earlier run can still write to that tree.
- The check does not run for the orchestrator or the reviewer of another CLI. Only the Claude orphan is observed (ADR 0027), so the other adapters are not verified to leave one.
- The check and the resume are not atomic. A holder that starts between them is not found.
- Interactive path, read from the code and not probed. A `role dispatch` process that a hard kill ends leaves its `claude` child alive in the same way, because both paths start the child through `exec`. The next dispatch marks the run `interrupted` and starts no child. `--resume-interrupted` then runs the turn with the kept session id (`src/role.mjs`), and the code holds no check for a live holder. The exposure is therefore the same as for `--continue-from`. This PR does not cover it for three reasons. Issue #647 and its acceptance name `--continue-from`. The interactive path has its own state file and lifecycle, and a check there needs its own design and its own probe. No probe of an interactive orphan exists. A follow-up must probe it first, then call `refuseHeldSessions` before the resumed turn of `--resume-interrupted`.
- The real upper bound of the read on POSIX is about 35 seconds: the 30 second bound, then the SIGTERM, then the 5 second force-kill delay that `exec` leaves at the execa default, for a process that ignores SIGTERM. A test with a 1 second bound and a shell that ignores SIGTERM asserts that the read ends in under 12 seconds and that the process is gone. The Windows bound is not measured.
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

- [Pull request #660](https://github.com/andromarces/agent-loops/pull/660)
- [Issue #669: SIGINT can end the runtime by signal before the cancel handler finishes](https://github.com/andromarces/agent-loops/issues/669)
- [Issue #647](https://github.com/andromarces/agent-loops/issues/647)
- [Issue #627](https://github.com/andromarces/agent-loops/issues/627)
- [ADR 0027: Save the session id of an in-tree transcript outside the work tree](0027-save-the-session-id-of-an-in-tree-transcript-outside-the-work-tree.md)
- Implementation: `refuseHeldSessions` in `src/lib/continuation.mjs`, `readProcessCommands` in `src/lib/process-ancestry.mjs`, and the call in `src/cli.mjs`. Documented in `README.md`.
- [ADR Index](README.md)
