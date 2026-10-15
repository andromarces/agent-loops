# 0039. Gate full-suite test runs with a machine-wide test slot

## Status

accepted

## Date

2026-10-15

## Context

Several `agent-loop` runs on one host start full-suite test runs in different work trees and projects at the same time. Each Vitest process starts close to one worker per core, and many tests spawn real `node`, `git`, and shell children. CPU-bound tests then reach the 15 s `testTimeout` and fail, while the same files pass alone. Separate test runners cannot see each other, so a worker cap per repository does not coordinate them (issue #847).

The repository already has an exclusive lock file with an owner record and stale-owner recovery (`src/lib/state-lock.mjs`, ADR 0020), and a shell runner with a process-tree kill for `--test-cmd` (ADR 0017, ADR 0028).

## Decision

1. **Subcommand.** `agent-loop test-slot [--slots <n>] [--wait <seconds>] [--] "<command>"` runs one command only while it holds one of N machine-wide slots. The command is one argument, run through the platform shell as `--test-cmd` runs its command. stdout and stderr pass through, and stdin is closed.
2. **Slots.** A slot is a lock file `slot-<i>.lock` under `<os tmpdir>/agent-loops/test-slots`. `AGENT_LOOP_TEST_SLOTS_ROOT` overrides the directory. Each acquisition pass runs under the short lock `acquire.lock` in the same directory. The pass counts the slot files held by live owners. While fewer than the caller's own N are held, it takes the lowest free index. Callers that disagree on N therefore never run more than the largest N among them, and an N=1 caller waits until no other holder runs. Every lock, owner record, and stale-owner recovery is that of `state-lock.mjs`, through `tryStateLock` (null for a busy lock), `lockHeld`, and `readLockOwner`.
3. **Count.** The default is `max(1, floor(os.availableParallelism() / 8))`. `--slots` and `AGENT_LOOP_TEST_SLOTS` override it. A flag wins, and an environment value is read only when its flag is absent: an invalid environment value is then a usage error, and with the flag it is ignored. The same rule applies to `--wait`.
4. **Wait.** A wrapper polls every 0.5 to 1 s, up to 1800 s by default. `--wait` and `AGENT_LOOP_TEST_SLOT_WAIT` override the bound, which must be more than 0. A slot won after the bound, for example by a pass that the acquire lock or a stale reclaim slowed, is freed unused. At the bound the command does not run, one error line goes to stderr, and the exit code is 75 (`EX_TEMPFAIL`).
5. **Exit codes.** The wrapper exits with the command's code, 128 plus the signal number for a command ended by a signal, 64 (`EX_USAGE`) for a usage error, and 130 or 143 when SIGINT or SIGTERM reached the wrapper. The same mapping holds for a nested wrapper.
6. **Release.** The slot is freed when the command ends, on an error, and on SIGINT or SIGTERM. A signal first ends the command's process group (POSIX) or tree (Windows) through `killLiveTrees`, waits for the command to end, then frees the slot.
7. **Nested call.** The command runs with `AGENT_LOOP_TEST_SLOT_HELD` set to a JSON record of the slot file and the owner nonce. A wrapper that starts with it set runs its command at once only while that slot file still holds that nonce and a live owner, so a wrapped script that calls the wrapper again cannot deadlock. A marker exported by hand, or one that outlived its holder, is ignored with a warning, and the wrapper acquires normally. A nested run does not start a process group of its own on POSIX, so the outer wrapper's kill of its command group also ends the nested command.
8. **Logs.** Wait, acquire, release, and the command's end are `info` lines, and the timeout is an `error` line. Every line goes to stderr, so the command's stdout stays clean. No line holds the command text.

## Consequences

- Every project and work tree of one OS user on a host shares the slots, with no dependency on `flock`, a shell `timeout`, or another platform tool.
- Callers with different N share one count of live holders, so the host never runs more than the largest N among them. A caller with a small N can wait long while callers with a larger N keep the count up.
- A signal sent to a nested wrapper alone ends its direct child on POSIX, because the nested command shares the outer group. A grandchild that the shell started can survive until the outer wrapper ends the group.
- The slot directory is not per user, as the runs root is not. Where `os.tmpdir()` is shared between OS users, as `/tmp` on Linux, the first user owns the directory, and another user gets exit 1 unless `AGENT_LOOP_TEST_SLOTS_ROOT` points elsewhere.
- A wrapper ended by a hard kill (SIGKILL, or `taskkill /F` on Windows) runs no handler. Its slot is reclaimed as stale, and its command tree can keep running outside a slot (ADR 0028). Windows delivers no catchable SIGTERM from another process, so only Ctrl+C (SIGINT) runs the ordered release there.
- The wait is not fair: a waiting wrapper takes the first slot it finds free.
- Routing `--test-cmd` and the child prompts through the slot is issue #848.

## Alternatives

1. **A worker cap in `vite.config.mjs`.** Rejected. It cannot see other projects and work trees.
2. **A new lock scheme, for example a lock directory or `flock`.** Rejected. `state-lock.mjs` already covers atomic create, owner record, and stale recovery on every platform, and `flock` is POSIX only.
3. **Join the remaining arguments into the command text.** Rejected. The calling shell removes the quotes of each argument, so a join changes the meaning of any argument with spaces or shell operators.
4. **Wait without a bound.** Rejected. A wrapper whose slot never frees would hang a run forever.
5. **Fixed slot files `slot-0` to `slot-<N-1>` per caller, with no count.** Rejected by the maintainer. A caller with N=1 could start while a caller with N=2 held `slot-1`, so callers that disagree on N could run more than any of them asked.
6. **A bare marker value such as `1`.** Rejected. A marker exported by hand, or inherited by a process after its holder exits, would disable the throttle.

## Authors

Andro Marces

## Links

- [Pull request #849](https://github.com/andromarces/agent-loops/pull/849)
- [Issue #847](https://github.com/andromarces/agent-loops/issues/847)
- [Issue #848](https://github.com/andromarces/agent-loops/issues/848)
- [ADR 0017: Run a test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0028: End the Windows process tree when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR Index](README.md)
