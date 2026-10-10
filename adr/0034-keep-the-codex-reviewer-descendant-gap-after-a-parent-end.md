# 0034. Keep the Codex reviewer descendant gap after a parent end

## Status

proposed

## Date

2026-10-10

## Context

Issue #712 (probe of issue #692, ADR 0027) found a late write by a Codex reviewer command. A `--reviewer-workspace-write` reviewer turn ran the committed script `sh ./check.sh` (`sleep 90`, then `echo ORPHAN > orphan-write-rev.txt`). The write landed 52 s after the `SIGTERM` of the headless parent, after a clean `git status` from the reviewer and from the driver. The mutation check reported no tree state, because the turn did not return (ADR 0027, probe of issue #692).

The issue leaves three options open: leave no such command after a parent end, detect it before the next turn, or record why the gap stays. The facts of the probe and of the code that bear on the choice:

- The `SIGKILL` of the first parent ended all 12 recorded descendants within 1.5 s. The first Codex thread holds `turn_aborted`, and no write came from it. The writer was a command of the second thread, which the continued run started itself. The `SIGTERM` came after that, and the host record does not show whether the Codex process survived it (checklist item for issue #708).
- **SIGTERM on POSIX, read from the source (execa 10.1.0, signal-exit 4.1.0).** The runtime starts every Codex turn through `exec` (`src/lib/exec.mjs`) with `killDescendants: true` and the execa default `cleanup: true`. `cleanup` registers an exit callback through `signal-exit`, which listens for `SIGHUP`, `SIGINT`, and `SIGTERM`. The runtime has no `SIGTERM` listener of its own, so on `SIGTERM` the `signal-exit` listener is the only one. It runs the callback, which calls the execa `kill` with the default signal `SIGTERM`. `killDescendants` spawns the child detached in its own process group and sends that signal to the group (`process.kill(-pid)`). `signal-exit` then re-sends `SIGTERM` to the parent, which ends at once. Two limits follow:
  - The signal is `SIGTERM`, not `SIGKILL`. A process of the group that traps or ignores it survives. A process that left the group, for example through its own session, is not signaled.
  - The execa `SIGKILL` escalation after `forceKillAfterDelay` (5 s) runs on a timer in the parent. The parent ends before the timer fires, so the escalation never runs on this path.
- **SIGTERM on Windows.** Node delivers no `SIGTERM` through `kill` there (ADR 0033 decision 9). The exit handler of ADR 0028 (`killLiveTrees`) runs on the `exit` event only.
- **SIGINT** is a separate path (ADR 0033). `cancelOnSigInt` adds a listener, so `signal-exit` does not act, and the run aborts through the cancel signal of execa.
- `SIGKILL` has no handler in any process. No parent code can end children on it.
- The probe of issue #712 therefore cannot tell the causes apart. By the code above, the group of the Codex child received `SIGTERM` when the continued parent got it. The probe did not observe that delivery. The shell command still wrote 52 s later. A command that traps the signal, or a command that Codex runs outside that process group, explains it. Neither is verified, and no record shows the process group of the shell command.
- The Codex adapter pre-assigns no id. It reads `thread_id` from the `thread.started` event of the output (`src/agents/codex.mjs`). A killed first turn leaves no id in the transcript, so a check by session id has no id to match for the turn of the probe. The second thread of the probe was a fresh `codex exec`, started by the continued run because the transcript held no id, and the `SIGTERM` ended that parent before any transcript write.
- A later turn of a role with a stored id runs as `codex exec resume <id> ... -`. The id is a positional argument. ADR 0031 and ADR 0032 match the flags `--session-id`, `--resume`, and `-r` (`holdsSession`), and only for a Claude role (`refuseHeldSessions`).
- The adapter passes no `--cd`. It sets the directory through the `cwd` option of `exec`. No live Codex command line holds the work tree path today. On this host (`codex-cli 0.163.0-alpha.4`), `codex exec --help` lists `-C, --cd <DIR>`, and `codex exec resume --help` lists no `--cd`.
- ADR 0032 found no working-directory property in the Windows process table, and the POSIX tools (`/proc/<pid>/cwd`, `lsof -d cwd`) are not verified. A match by work tree is not available.
- The write came from a script that the sandbox allows by operator choice (ADR 0019, opt-in `--reviewer-workspace-write`), not from a model decision.
- The host of this change is Windows. Windows has no `SIGTERM` delivery through `kill` (ADR 0033 decision 9), and the Codex probe ran on macOS only.

## Decision

1. The runtime adds no behavior for a Codex reviewer descendant that outlives its parent. The gap stays. This decision follows ADR 0031 decision 7 and ADR 0032 decision 4, which also leave the gaps that need a process that the runtime did not start in this run.
2. The runtime adds no new `SIGTERM` handling. A `SIGTERM` already ends the process group of the child with `SIGTERM` through execa (see Context). What survives, and why, is not verified: whether the Codex process, a trapping command, or a command outside the group wrote after the signal is open in issue #708. A stronger end signal needs that result, and it cannot cover `SIGKILL`. The Windows host cannot deliver the signal, so a test there would assert a path that never runs.
3. The runtime does not detect such a command before a turn. The stored-id match and the `--cd` match are evaluated in Alternatives 2 and 3 and are deferred. A bare process-name match would refuse a run for any unrelated `codex` or `sh` process on the host.
4. The operator rule is stated in the README. After a parent of a `--reviewer-workspace-write` run ends by a signal other than `SIGINT`, the operator checks for a surviving `codex` process or shell child and the state of the work tree before the next run.
5. The decision has no test, because the code does not change. The acceptance allows this: the ADR records why the gap stays.

## Consequences

- A write from a descendant of a Codex reviewer turn can land after the parent ends, after a clean tree report, and the runtime reports nothing for it. The operator sees it only by a check of the process table and of the tree.
- A run of read-only reviewer turns is not affected. The sandbox of those turns blocks writes (ADR 0019).
- Reopen this decision when one of these holds:
  - The live POSIX `SIGTERM` probe of issue #708 shows which process survives and why. A surviving Codex process of a resumed turn reopens Alternative 2 and Alternative 3. A surviving command outside the process group or one that traps the signal calls for a different end of the tree, and a test for it runs on POSIX only.
  - Codex gains a pre-assigned session id, so a flag check can find the holder of a first turn.
  - A verified call exposes the working directory of a process on Windows and POSIX.
- Not verified: a Codex reviewer that chooses to write, a write-capable Claude orchestrator, Linux, and the cause of the first-run descendants ending with the `SIGKILLed` parent.

## Alternatives

1. **A stronger end of the child tree on `SIGTERM`**: rejected for now. A `SIGTERM` already reaches the group through execa. A change to `SIGKILL` on that path (`killLiveTrees`, ADR 0033) needs the result of issue #708 to show that it helps. The signal cannot be delivered or tested on this host, and a `SIGKILL` of the parent stays uncovered.
2. **Detect a live `codex exec resume <id>` process by the stored thread id**: deferred. The runtime knows the id of a Codex role after a completed turn, in the transcript and in the run state. A check would reuse the process-table read of `refuseHeldIds`, add a rule for the positional `resume <id>` form next to the flag rule of `holdsSession`, and extend `refuseHeldSessions` from Claude roles to Codex roles. A test with an injected process table runs on this host. It is deferred for three reasons:
   - It misses the case of issue #712. The probe turn was a fresh `codex exec` with no stored id.
   - It finds the Codex process only. The probe shows that the writer was `sh ./check.sh`, whose command line holds no id, and no record shows a live Codex process after the end of the parent.
   - A refusal needs a live matching process, and none is observed. The probe shows that the Codex children ended with a `SIGKILLed` parent. Whether a `codex exec resume` process survives a `SIGTERM` is the open result of issue #708. A check for a holder that no probe has shown is speculative (ADR 0032 decision 4 sets the same bar).

   Reopen it when issue #708 shows a surviving Codex process of a resumed turn. The positional rule and the extension to Codex roles are then the smallest change.

3. **Match a live Codex process by an explicit `--cd <work tree>` argument**: deferred. The adapter passes no `--cd` today, so no running process carries the path. The change adds `--cd` to every Codex command line and then reads the process table before a turn. A test with an injected table runs on this host. It is deferred for these reasons:
   - `codex exec resume --help` on this host lists no `--cd`, so a resumed turn can fail on the new argument. No Codex run of a changed command line is possible here, and the macOS check is open.
   - `--cd` sets the working root of the Codex turn. The change moves that root from the `cwd` of the process to an argument, and no run shows that the sandbox root stays the same.
   - A match by path refuses every live Codex process of the work tree, including a legitimate one of another run or another parent session. It cannot tell a leftover from a live run, and ADR 0007 allows concurrent runs.
   - It finds the Codex process only, and the writer of the probe was a shell child (see Alternative 2).

   Reopen it with the check of issue #708 and a verified `--cd` form for `exec resume`.

4. **Detect a holder by process name**: rejected. A name match refuses unrelated `codex` or `sh` processes of the host.
5. **Add a lock file or a registry of live reviewer children**: rejected. A hard kill leaves a stale entry, and ADR 0020 shows that it needs a liveness check. ADR 0032 decision 4 rejects a new store for the same reason.
6. **End the surviving process on the next run**: rejected by ADR 0031 decision 7. The runtime would signal a process that it did not start in this run.

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
