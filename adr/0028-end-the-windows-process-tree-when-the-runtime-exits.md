# 0028. End the Windows process tree of a child when the runtime exits

## Status

accepted. The repository owner approved the hard-kill limit of decision 4 (issue #635).

## Date

2026-10-10

## Context

Every runtime child (`exec`, `runGh`, `assertGitWorkTree`, and the test command of ADR 0017) starts with execa `cleanup: true` and `killDescendants: true`. On Windows, a parent that called `process.exit` while a nested `pnpm exec` run was live left that run alive. Only the direct `cmd.exe` child ended (issue #612, probe of issue #602).

Cause, from the execa 10.1.0 source and the probes below: `cleanup` runs `taskkill /pid <pid> /T /F` through an asynchronous `execFile` inside the exit handler, and `taskkill /T` cannot find the descendants of a process that exited. The tree survived that path.

Probes on 2026-10-10 (Windows 11 Pro 10.0.26220, Node v26.8.1, pnpm 12.10.1, execa 10.1.0). Parent runs `pnpm exec node hang.cjs` with the options above, then exits after 4 s to 12 s. A script outside the repository counted the processes with the `hang.cjs` path in the command line 4 s to 5 s after the parent exit.

| Parent exit                            | Handler                                                                | Alive after                                       |
| -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `process.exit(0)`                      | execa `cleanup` only                                                   | 2 (`pnpm.exe`, `node.exe`) in every run, 5 delays |
| `process.exit(0)`                      | execa `cleanup` and a synchronous `taskkill /T /F` in the `exit` event | 0                                                 |
| `process.kill(process.pid, "SIGKILL")` | the same synchronous `taskkill`                                        | 2                                                 |

A parent that the Vitest runner spawned lost its nested run at once with or without the handler. The runner tree cleans up there, so the test starts the parent outside it.

## Decision

1. `killTreeOnExit` in `src/lib/exec-tree.mjs` wraps each `execa` call that sets `killDescendants`: `exec`, `runGh`, `assertGitWorkTree`, the `--test-cmd` run, and the nested run of `tests/tmpdir-isolation.test.mjs`. On Windows it records the run and registers one `process.on("exit")` handler. Off Windows it changes nothing: execa signals the process group in its own exit handler. A spawn with no pid, or a pid that is not a positive integer, is not recorded.
2. For each recorded run, the handler runs `taskkill /pid <pid> /T /F` with `spawnSync`, so the call finishes before the parent ends. It skips a run that settled, and a child that exited (read from the Node child process that execa wraps), because the OS can reassign the pid of an exited child. It never signals by name, by environment, or by a host-wide scan (ADR 0017 item 4).
3. The handler runs `taskkill.exe` from `<SystemRoot>\System32` only, where `SystemRoot` or `windir` is a drive-absolute path, as execa does. It never uses a relative path or a `PATH` lookup. If neither variable is valid, it logs a warning and kills the direct child only. Each call has a 5 s bound. The log depends on the result. Exit code 0 logs `debug` that the tree ended. Exit code 128 (no process has the pid) logs `debug` that taskkill found no process and did not check descendants: it is neither a failure nor a confirmed kill, because `taskkill /T` walks the parent links of a live root only. Any other result, including an error or a timeout, logs at `warn` level. The handler never throws, so the remaining runs still get their kill.
4. **Accepted limit.** A parent that a hard kill ends (`TerminateProcess`, Task Manager, `taskkill /F` on the parent) runs no handler, and its nested run survives. Neither Node nor execa exposes a Windows job object, and a native addon or helper process would add a dependency for a rare case. The repository owner accepted this limit (issue #635).

## Consequences

- Cleanup is conditional. A runtime that exits through `process.exit`, a fatal error, or a normal end ends the tree of each recorded run whose root is alive at exit, if `taskkill` runs and succeeds within its 5 s bound. It reports nothing for a descendant of a root that already exited, and it does not check that a tree ended beyond the `taskkill` exit code.
- A hard kill of the runtime, and a signal that ends it with no `exit` event, can still leave a tree. The operator ends it by hand.
- The exit handler blocks the exit for the length of one `taskkill` per live child, up to 5 s each. No total deadline spans the live runs, so n live runs can delay the exit by up to 5 s times n. The runtime has few concurrent children, so the limit stays unmitigated, and a total deadline is the upgrade if that changes. A run that `taskkill` fails to end, or whose bound expires, can leave its tree, and the `warn` line names it.
- A run that no wrapped call started has no handler. The `git` calls of `src/lib/local-files.mjs` and the `copilot` launcher set no `killDescendants` and stay out of scope.

## Alternatives

1. **A job object with kill-on-close**: it covers a hard kill, but Node has no API, and a helper binary or a native addon is a new dependency. Rejected for the cost.
2. **Rely on execa `cleanup`**: it leaves the tree alive on `process.exit`, as probed. Rejected.
3. **A host-wide scan for survivors**: it selects processes the runtime does not own (ADR 0017 item 4). Rejected.

## Authors

Andro Marces

## Links

- [Pull request #623: fix: end the Windows process tree of a child when the runtime exits](https://github.com/andromarces/agent-loops/pull/623)
- [Issue #612: Windows: nested process tree outlives a parent that exits before the execa timeout](https://github.com/andromarces/agent-loops/issues/612)
- [Issue #602: Verify the nested isolation tree kill](https://github.com/andromarces/agent-loops/issues/602)
- [Issue #635: Decide the ADR 0028 hard-kill limit for the Windows process tree](https://github.com/andromarces/agent-loops/issues/635)
- [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- Implementation: `killTreeOnExit` in `src/lib/exec-tree.mjs`, used in `src/lib/exec.mjs`, `src/lib/ci-gate.mjs`, `src/lib/snapshot.mjs`, `src/lib/test-cmd.mjs`, and `tests/tmpdir-isolation.test.mjs`; test in `tests/lib/exec-tree.test.mjs`
- [ADR Index](README.md)
