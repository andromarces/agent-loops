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
2. **Slots.** Slot `i` is the lock file `slot-<i>.lock` under `<os tmpdir>/agent-loops/test-slots`. `AGENT_LOOP_TEST_SLOTS_ROOT` overrides the directory. A wrapper tries `slot-0` to `slot-<N-1>` in order. Acquisition, the owner record, and the stale-owner recovery are those of `state-lock.mjs`, through `tryStateLock`, which returns null for a busy lock instead of throwing.
3. **Count.** The default is `max(1, floor(os.availableParallelism() / 8))`. `--slots` and `AGENT_LOOP_TEST_SLOTS` override it, and the flag wins.
4. **Wait.** A wrapper polls every 0.5 to 1 s, up to 1800 s by default. `--wait` and `AGENT_LOOP_TEST_SLOT_WAIT` override the bound. At the bound the command does not run, one error line goes to stderr, and the exit code is 75 (`EX_TEMPFAIL`).
5. **Exit codes.** The wrapper exits with the command's code, 128 plus the signal number for a command ended by a signal, 64 (`EX_USAGE`) for a usage error, and 130 or 143 when SIGINT or SIGTERM reached the wrapper.
6. **Release.** The slot is freed when the command ends, on an error, and on SIGINT or SIGTERM. A signal first ends the command's process group (POSIX) or tree (Windows) through `killLiveTrees`, waits for the command to end, then frees the slot.
7. **Nested call.** The command runs with `AGENT_LOOP_TEST_SLOT_HELD=1`. A wrapper that starts with it set runs its command at once, so a wrapped script that calls the wrapper again cannot deadlock.
8. **Logs.** Wait, acquire, release, and the command's end are `info` lines, and the timeout is an `error` line. Every line goes to stderr, so the command's stdout stays clean. No line holds the command text.

## Consequences

- Every project and work tree of one OS user on a host shares the slots, with no dependency on `flock`, a shell `timeout`, or another platform tool.
- Callers with different N use the same slot files, so the slots below the smallest N stay shared by all of them.
- The slot directory is not per user, as the runs root is not. Where `os.tmpdir()` is shared between OS users, as `/tmp` on Linux, the first user owns the directory, and another user gets exit 1 unless `AGENT_LOOP_TEST_SLOTS_ROOT` points elsewhere.
- A wrapper ended by a hard kill (SIGKILL, or `taskkill /F` on Windows) runs no handler. Its slot is reclaimed as stale, and its command tree can keep running outside a slot (ADR 0028). Windows delivers no catchable SIGTERM from another process, so only Ctrl+C (SIGINT) runs the ordered release there.
- The wait is not fair: a waiting wrapper takes the first slot it finds free.
- Routing `--test-cmd` and the child prompts through the slot is issue #848.

## Alternatives

1. **A worker cap in `vite.config.mjs`.** Rejected. It cannot see other projects and work trees.
2. **A new lock scheme, for example a lock directory or `flock`.** Rejected. `state-lock.mjs` already covers atomic create, owner record, and stale recovery on every platform, and `flock` is POSIX only.
3. **Join the remaining arguments into the command text.** Rejected. The calling shell removes the quotes of each argument, so a join changes the meaning of any argument with spaces or shell operators.
4. **Wait without a bound.** Rejected. A wrapper whose slot never frees would hang a run forever.

## Authors

Andro Marces

## Links

- [Issue #847](https://github.com/andromarces/agent-loops/issues/847)
- [Issue #848](https://github.com/andromarces/agent-loops/issues/848)
- [ADR 0017: Run a test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- [ADR 0020: Remove orphan claim files with a writer liveness check](0020-remove-orphan-claim-files-with-a-writer-liveness-check.md)
- [ADR 0028: End the Windows process tree when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [ADR Index](README.md)
