# 0033. Cancel a run on SIGINT and escalate on a second SIGINT

## Status

accepted

## Date

2026-10-10

## Context

`Ctrl-C` sends SIGINT to the runtime. Issue #669 found that a `once` listener lets the exit handler of execa find no SIGINT listener after the first signal. The handler then re-raises the signal and ends the runtime by signal, before the run sets exit code 130 and writes its transcript.

PR #689 recorded this decision in ADR 0029 (decision 8 and a SIGINT sentence in decision 2). ADR 0029 is `superseded` by ADR 0031, so the decision sat in a superseded record and in no index entry of an active ADR (issue #693). The SIGINT decision does not depend on the held-session refusal of ADR 0029 and ADR 0031.

## Decision

1. The runtime keeps one persistent SIGINT listener for the whole run (`cancelOnSigInt` in `src/lib/sigint.mjs`). The listener uses `on`, not `once`. Node removes a `once` listener before it runs, so the exit handler of execa would find no listener and re-raise the signal (issue #669). Every exit path of the caller removes the listener. The run keeps the listener until the run ends, so the exit handler of execa finds another listener and does not re-raise the signal.
2. The first SIGINT aborts the run signal. The read of the process table (ADR 0029 decision 2, ADR 0031) also ends on the cancel signal of the run, and a cancel is not a warning. It ends the run before any turn. The exit code is 130.
3. A second SIGINT escalates and does not abandon the run. It does these steps in this order: force-kills the process tree of every live child, writes the transcript or envelope that the run holds, and exits with code 130. The kill is SIGKILL to the process group on POSIX, and `taskkill /pid <pid> /T /F` with `spawnSync` on Windows (`killLiveTrees` in `src/lib/exec-tree.mjs`, ADR 0028). It reaches each child that `killTreeOnExit` records: `exec`, `runGh`, `assertGitWorkTree`, and the test command. `src/cli.mjs` writes the transcript with `exitCode` 130, the error `Interrupted by SIGINT`, the events and session ids that the run holds, by a synchronous temp-file write and rename (`writeFileAtomicSync`). `src/role.mjs` writes one error envelope with the same error.
4. The second SIGINT keeps:
   - A SIGKILL to each recorded child. Exit code 130.
   - An earlier transcript whole, because the write is a rename. A file symlink at the transcript path, dangling or not, keeps its link and the write lands at its final target, as in the async write. A transcript that names the `--continue-from` file is replaced as in a normal exit.
5. Kill failures. `killLiveTrees` never throws and goes on to the next child. On POSIX, a SIGKILL that execa does not deliver (it returns `false`) logs a `warn` line with the pid. On Windows, a failed or timed-out `taskkill` logs a `warn` line, and exit code 128 (no process has the pid) logs `debug` only, because `taskkill /T` does not find the descendants of a root that already exited. In each case the child can survive, so "no recorded child outlives the runtime" holds only when the kill is delivered. A child outside the recorded set (the `copilot` launcher and the `git` calls of `src/lib/local-files.mjs`) and an orphan that left the process group can also survive (ADR 0017 item 4, ADR 0028 item 4).
6. Envelope of `role`. One guard serves the normal path and the second SIGINT, so stdout holds at most one envelope. If no envelope write has started, the second SIGINT writes the cancel envelope with `writeSync` in a loop that continues after a partial write and retries `EAGAIN` for at most 2 s. That envelope is shorter than `PIPE_BUF`, so a pipe takes it whole or not at all. A failure before any byte is written (for example `EPIPE` on the first call) logs an error and writes no envelope. A permanent error after a partial write (for example `ENOSPC` on a file or a full disk) logs an error and leaves the bytes already written, a truncated envelope, on stdout, and the exit is still 130. The 2 s limit on `EAGAIN` ends the same way. If the normal write is in flight, the second SIGINT writes nothing and the exit waits for that write for at most 2 s, then exits 130, so a consumer that does not read stdout can leave that one envelope cut. If the write is done, the exit follows at once.
7. Transcript write failures. A write that fails (a full disk, a symlink loop that fails with `ELOOP`, or a Windows rename that a reader blocks, with no retry) logs an error, writes no transcript, and still exits 130. A write that stalls in the OS blocks the exit, because a synchronous call has no bound.
8. The second SIGINT drops: the mutation check and snapshot of the turn, the `gate` event, the summary, and the state-file writes of `role`. The async removal of the session record is skipped, so a stale record stays, and it no longer matches the digest of the new transcript.
9. Windows has no SIGINT delivery through `kill`, so the real-signal tests run on POSIX CI only. The Windows path of `killLiveTrees` has a test that runs here. A Ctrl-C from a real Windows console is not verified.

## Consequences

- A second SIGINT ends the run with the kept and dropped guarantees of decisions 4 to 8. The operator gives up the mutation check, the `gate` event, and the state-file writes of that run, and a stale session record can stay.
- A child can survive a second SIGINT in the cases of decision 5. The operator must check for it.
- A write that stalls in the OS blocks the exit (decision 7), and a consumer that does not read stdout can leave one cut envelope (decision 6).
- The Windows console path stays unverified (decision 9).

## Alternatives

1. **A `once` listener**: rejected. It is the cause of issue #669: the exit handler of execa re-raises the signal before the run sets exit 130.

## Authors

Andro Marces

## Links

- [Issue #669: SIGINT can end the runtime by signal before the cancel handler finishes](https://github.com/andromarces/agent-loops/issues/669)
- [Pull request #689](https://github.com/andromarces/agent-loops/pull/689)
- [Issue #693: Record the SIGINT cancel decision in an active ADR instead of superseded ADR 0029](https://github.com/andromarces/agent-loops/issues/693)
- [ADR 0028: End the Windows process tree of a child when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR 0031: Refuse --continue-from and --resume-interrupted while a live process holds a Claude session](0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md)
- Implementation: `cancelOnSigInt` in `src/lib/sigint.mjs`, `killLiveTrees` in `src/lib/exec-tree.mjs`, and the force-exit writes in `src/cli.mjs` and `src/role.mjs`.
- [ADR Index](README.md)
