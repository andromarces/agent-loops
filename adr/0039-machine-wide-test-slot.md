# 0039. Gate full-suite test runs with a machine-wide test slot

## Status

partially-superseded

Partially superseded by [ADR 0046](0046-default-the-test-slot-count-to-one.md): it replaces decision 3 (the default count). The `--slots` and `AGENT_LOOP_TEST_SLOTS` overrides and every other decision hold.

## Date

2026-10-15

## Context

Several `agent-loop` runs on one host start full-suite test runs in different work trees and projects at the same time. Each Vitest process starts close to one worker per core, and many tests spawn real `node`, `git`, and shell children. CPU-bound tests then reach the 15 s `testTimeout` and fail, while the same files pass alone. Separate test runners cannot see each other, so a worker cap per repository does not coordinate them (issue #847).

The repository already has an exclusive lock file with an owner record and stale-owner recovery (`src/lib/state-lock.mjs`, ADR 0020), and a shell runner with a process-tree kill for `--test-cmd` (ADR 0017, ADR 0028).

## Decision

1. **Subcommand.** `agent-loop test-slot [--slots <n>] [--wait <seconds>] [--] "<command>"` runs one command only while it holds one of N machine-wide slots. The command is one argument, run through the platform shell as `--test-cmd` runs its command. stdout and stderr pass through, and stdin is closed.
2. **Slots.** A slot is a lock file `slot-<i>.lock` under `<os tmpdir>/agent-loops/test-slots`. `AGENT_LOOP_TEST_SLOTS_ROOT` overrides the directory. Each acquisition pass runs under the short lock `acquire.lock` in the same directory. The pass counts the held slot files: a file with a live owner, and a file that cannot be read or parsed, unless the stale rules of `state-lock.mjs` prove it stale (fail closed). While fewer than the caller's own N are held, it takes the lowest free index. Callers that disagree on N therefore never run more than the largest N among them, and an N=1 caller waits until no other holder runs. Every lock, owner record, and stale-owner recovery is that of `state-lock.mjs`, through `tryStateLock` (null for a busy lock), `lockHeld`, and `readLockOwner`.
3. **Count.** The default was `max(1, floor(os.availableParallelism() / 8))`; ADR 0046 replaced it with 1. `--slots` and `AGENT_LOOP_TEST_SLOTS` override it. A flag wins, and an environment value is read only when its flag is absent: an invalid environment value is then a usage error, and with the flag it is ignored. The same rule applies to `--wait`.
4. **Wait.** A wrapper polls every 0.5 to 1 s, up to 1800 s by default. `--wait` and `AGENT_LOOP_TEST_SLOT_WAIT` override the bound. The command starts only strictly before the bound: a slot won at or after it, for example by a pass that the acquire lock or a stale reclaim slowed, is freed unused. `--wait 0` is one attempt: the command runs if a slot is free now, otherwise the wrapper exits 75 at once. At the bound the command does not run, one error line goes to stderr, and the exit code is 75 (`EX_TEMPFAIL`).
5. **Exit codes.** The wrapper exits with the command's code, 128 plus the signal number for a command ended by a signal, 64 (`EX_USAGE`) for a usage error, 130 or 143 when SIGINT or SIGTERM reached the wrapper, and 1 for any other wrapper failure. The same mapping holds for a nested wrapper. A failed release of the short acquisition lock after a slot was taken frees that slot, and the wrapper exits 1 without running the command.
6. **Release.** The slot is freed when the command ends, on an error, and on SIGINT or SIGTERM. A signal first ends the command's process group (POSIX) or tree (Windows) through `killLiveTrees`, waits for the command to end, then frees the slot.
7. **Nested call.** The command runs with `AGENT_LOOP_TEST_SLOT_HELD` set to a JSON record of the slot file and the owner nonce. A wrapper that starts with it set runs its command at once only while that slot file still holds that nonce and a live owner, so a wrapped script that calls the wrapper again cannot deadlock. A marker exported by hand, or one that outlived its holder, is ignored with a warning, and the wrapper acquires normally. A nested run does not start a process group of its own on POSIX, so the outer wrapper's kill of its command group also ends the nested command.
8. **Logs.** Wait, acquire, release, and the command's end are `info` lines, and the timeout is an `error` line. Every line goes to stderr, so the command's stdout stays clean. No line holds the command text.

## Consequences

- Every project and work tree of one OS user on a host shares the slots, with no dependency on `flock`, a shell `timeout`, or another platform tool.
- Callers with different N share one count of live holders, so the host never runs more than the largest N among them. A caller with a small N can wait long while callers with a larger N keep the count up.
- **Approved limit.** The maintainer approved this limit on 2026-10-15: on POSIX, a signal sent only to a nested wrapper ends its direct child, because the nested command shares the outer group, and a grandchild that the shell started can survive. A signal to the outer wrapper ends the whole group, the nested wrapper and its command included.
- **Approved limit.** The maintainer approved this limit on 2026-10-15: detached work that a wrapped command starts, for example through `setsid`, a detached spawn, or a daemon, can outlive the slot release. The release follows the end of the command's process group on POSIX and of its process tree on Windows, so such work runs outside any slot, as the orphan limit of ADR 0017 states for `--test-cmd`.
- The slot directory is not per user, as the runs root is not. Where `os.tmpdir()` is shared between OS users, as `/tmp` on Linux, the first user owns the directory, and another user gets exit 1 unless `AGENT_LOOP_TEST_SLOTS_ROOT` points elsewhere.
- A wrapper ended by a hard kill (SIGKILL, or `taskkill /F` on Windows) runs no handler. Its slot is reclaimed as stale, and its command tree can keep running outside a slot (ADR 0028). Windows delivers no catchable SIGTERM from another process, so only Ctrl+C (SIGINT) runs the ordered release there.
- The wait is not fair: a waiting wrapper takes the first slot it finds free.
- ADR 0046 replaces the default count (decision 3) with 1.
- ADR 0040 routes `--test-cmd` and the child prompts through the slot (issue #848).

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
- [ADR 0046: Default the test slot count to one](0046-default-the-test-slot-count-to-one.md)
- [ADR 0040: Run the test command in a test slot and route child full suites through the wrapper](0040-run-the-test-command-in-a-test-slot.md)
- [ADR 0017: Run a test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0028: End the Windows process tree when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR Index](README.md)
