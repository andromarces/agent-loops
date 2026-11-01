# 0033. Cancel a run on SIGINT and escalate on a second SIGINT

## Status

partially-superseded

Superseded by [ADR 0036: Bound every snapshot-path read and end the evidence snapshot on a second cancel](0036-bound-every-snapshot-path-read-and-end-the-evidence-snapshot-on-a-second-cancel.md): decision 8 no longer holds for the after-turn and after-command snapshots. A second SIGINT that arrives while one of them runs ends it and reports the evidence as not captured. The exit waits until the run writes its result. The other decisions remain in force.

## Date

2026-10-10

## Context

`Ctrl-C` sends SIGINT to the runtime. Issue #669 found that a `once` listener lets the exit handler of execa find no SIGINT listener after the first signal. The handler then re-raises the signal and ends the runtime by signal, before the run sets exit code 130 and writes its transcript.

PR #689 recorded this decision in ADR 0029 (decision 8 and a SIGINT sentence in decision 2). ADR 0029 is `superseded` by ADR 0031, so the decision sat in a superseded record and in no index entry of an active ADR (issue #693). The SIGINT decision does not depend on the held-session refusal of ADR 0029 and ADR 0031.

## Decision

1. The runtime keeps one persistent SIGINT listener for the whole run (`cancelOnSigInt` in `src/lib/sigint.mjs`). The listener uses `on`, not `once`. Node removes a `once` listener before it runs, so the exit handler of execa would find no listener and re-raise the signal (issue #669). Every exit path of the caller removes the listener. The run keeps the listener until the run ends, so the exit handler of execa finds another listener and does not re-raise the signal.
2. The first SIGINT aborts the run signal. The process-table read of the held-session check (ADR 0031) also ends on the cancel signal of the run, and a cancel is not a warning. It ends the run before any turn. The exit code is 130.
3. A second SIGINT escalates and does not abandon the run. It does these steps in this order: force-kills the process tree of every live child, writes the transcript or envelope that the run holds, and exits with code 130. The kill is SIGKILL to the process group on POSIX, and `taskkill /pid <pid> /T /F` with `spawnSync` on Windows (`killLiveTrees` in `src/lib/exec-tree.mjs`, ADR 0028). It reaches each child that `killTreeOnExit` records: `exec`, `runGh`, `assertGitWorkTree`, and the test command. `src/lib/transcript.mjs` writes the transcript with `exitCode` 130, the error `Interrupted by SIGINT`, the events and session ids that the run holds, by a synchronous temp-file write and rename (`writeFileAtomicSync`). `src/role.mjs` writes one error envelope with the same error.
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
- Verified on macOS 27.2 (Darwin 27.2.0, arm64), Node v26.11.1, Claude Code 2.1.296, with live `claude` turns (issue #695, probe on 2026-10-10). Each probe ran in a throwaway Git repository under the system temporary directory. The worker turn ran one long `Bash` call, `node -e "setTimeout(()=>{},600000)"`. The probe sent `kill -INT` to the runtime pid only, not to the process group.
  - Headless `agent-loop` with `claude` as orchestrator, worker, and reviewer, one SIGINT: exit 130. Stderr held `worker canceled by signal` and `Interrupted by SIGINT`. The transcript held `exitCode` 130, the error `Interrupted by SIGINT`, and the events `invocation` (orchestrator, `ok`), `action`, and `invocation` (worker, `error`).
  - Headless, a second SIGINT sent after a 0.2 s sleep, with the runtime alive: exit 130. Stderr held `second SIGINT: ending the child processes and exiting with code 130`. The transcript held `exitCode` 130, the same error, the events `invocation` (orchestrator) and `action`, and the worker session id. It held no worker `invocation` event.
  - `role dispatch --role worker` with `--transcript`, one SIGINT: exit 130. Stdout held `{"role":"worker","status":"error","error":"claude was canceled."}`. The transcript file held an `invocation` event and a `result` event for the worker.
  - `role dispatch`, a second SIGINT after a 0.2 s sleep: exit 130. Stdout held `{"status":"error","error":"Interrupted by SIGINT"}` and stderr held the `second SIGINT` warning. No transcript file existed.
  - In each of the four runs, no pid from the process listing taken before the first signal was alive after the exit. The listing held the `claude` child, its helper processes, the `Bash` tool shell, and the `node` sleeper. The `Bash` tool shell and the sleeper ran in a process group other than that of `claude`.
  - Not covered: a second SIGINT after the cleanup took longer than 0.2 s, a real terminal Ctrl-C to the process group, and the `codex` adapter.
- macOS probe of the deferred SIGINT cases (issue #708 item A, 2026-11-02). The probe run saved no host facts, and these were read after the probes. Host: macOS 27.2 (arm64, build 26B123), Node v27.0.0-alpha.0.0.0, Claude Code 2.1.316, codex-cli 0.166.0, and Git 2.56.0. The branch reflog, also read after the probes, holds `9767ef3f` across the probe times. Each probe ran in a disposable Git repository under the private temporary directory, with a separate `AGENT_LOOP_RUNS_ROOT` and a transcript outside the work tree. The driver signaled the parent by exact pid in probes `A1`, `A3-one`, and `A3-two`, and probe `A2` wrote the interrupt character to a pseudo-terminal.
  - Second SIGINT after cleanup past 0.2 s (probe `A1`): the worker ran the `node` sleeper, and the first `SIGINT` came at 17890 ms. The runtime was alive 537 ms later, and the `claude` worker row read `20909 19184 20909 claude -p`. The second `SIGINT` then escalated. The exit code was 130 at 547 ms, and stderr held the `second SIGINT` warning. The transcript held `exitCode` 130 and the error `Interrupted by SIGINT`. It held the orchestrator `invocation` and `action` events, with no worker `invocation` event.
  - Survivors of probe `A1`: the process listing at the trigger held six pids. No pid was alive in the saved `survivedAtExitSample` field, and a fresh signal 0 check found none after the probe cleanup.
  - Real terminal Ctrl-C (probe `A2`): a `pty.fork()` child ran the CLI, and the driver wrote `0x03` to the pty master. A control run with a shell `INT` trap printed `trap-received-INT` and exited 42, so the terminal driver delivered the signal to the foreground group. The worker turn ran the same `node` sleeper. The Ctrl-C came 15767 ms after the spawn, and the exit code was 130 after 992 ms. The transcript held `exitCode` 130 and a worker `invocation` event with status `error`. No recorded pid was alive in the saved `survivedAtExitSample` field.
  - One SIGINT on the `codex` adapter (probe `A3-one`): the worker was `codex` with `gpt-5.6-luna`. The signal came 16528 ms after the spawn, and the exit code was 130 after 70 ms. The transcript held `exitCode` 130, the error, and a worker `invocation` event with status `error`. The codex CLI and its helpers ended. The worker command `node -e ... setTimeout(()=>{},600000)` ran in its own group and stayed alive with parent pid 1 in the saved `survivedAtExitSample` field. The driver ended it by exact pid.
  - Two SIGINTs on the `codex` adapter (probe `A3-two`): the second signal came 44 ms after the first, while the runtime was alive. Stderr held the `second SIGINT` warning, and the exit code was 130 after 50 ms. The transcript held `exitCode` 130 and no worker `invocation` event. The same worker command stayed alive in the saved `survivedAtExitSample` field, and the driver ended it by exact pid.
  - The surviving command matches decision 5, the case of a child that left the process group. ADR 0063 decision 5 records that a Codex shell command runs in its own group. Issue #1326 holds the related tree-end decision for a Codex reviewer command.

## Alternatives

1. **A `once` listener**: rejected. It is the cause of issue #669: the exit handler of execa re-raises the signal before the run sets exit 130.

## Authors

Andro Marces

## Links

- Partially superseded by [ADR 0036](0036-bound-every-snapshot-path-read-and-end-the-evidence-snapshot-on-a-second-cancel.md) (decision 8)
- [Issue #669: SIGINT can end the runtime by signal before the cancel handler finishes](https://github.com/andromarces/agent-loops/issues/669)
- [Issue #695: Verify the SIGINT cancel path during a live agent turn on macOS or Linux](https://github.com/andromarces/agent-loops/issues/695)
- [Issue #708: Verification checklist: macOS](https://github.com/andromarces/agent-loops/issues/708)
- [Issue #1326: End the Codex reviewer command tree on POSIX after a parent signal](https://github.com/andromarces/agent-loops/issues/1326)
- [Pull request #689](https://github.com/andromarces/agent-loops/pull/689)
- [Issue #693: Record the SIGINT cancel decision in an active ADR instead of superseded ADR 0029](https://github.com/andromarces/agent-loops/issues/693)
- [ADR 0028: End the Windows process tree of a child when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR 0031: Refuse --continue-from and --resume-interrupted while a live process holds a Claude session](0031-refuse-continue-from-and-resume-interrupted-while-a-live-process-holds-a-claude-session.md)
- Implementation: `cancelOnSigInt` in `src/lib/sigint.mjs`, `killLiveTrees` in `src/lib/exec-tree.mjs`, and the force-exit writes in `src/lib/transcript.mjs` and `src/role.mjs`.
- [ADR Index](README.md)
