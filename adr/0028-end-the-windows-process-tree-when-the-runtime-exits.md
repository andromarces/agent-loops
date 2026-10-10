# 0028. End the Windows process tree of a child when the runtime exits

## Status

proposed

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

1. `killTreeOnExit` in `src/lib/exec-tree.mjs` wraps each `execa` call that sets `killDescendants`. On Windows it records the child pid, drops it when the run settles, and registers one `process.on("exit")` handler that runs `taskkill /pid <pid> /T /F` with `spawnSync` for each live pid. The call finishes before the parent ends. On other platforms it changes nothing: execa signals the process group in its own exit handler.
2. The handler kills only a pid that the runtime started and that has not settled. It never signals by name, by environment, or by a host-wide scan (ADR 0017 item 4).
3. **Proposed limit, needs approval from the repository owner.** A parent that a hard kill ends (`TerminateProcess`, Task Manager, `taskkill /F` on the parent) runs no handler, and its nested run survives. Neither Node nor execa exposes a Windows job object, and a native addon or helper process would add a dependency for a rare case. The owner must approve this limit before the status becomes `accepted`.

## Consequences

- A runtime that exits through `process.exit`, a fatal error, or a normal end leaves no child tree on Windows.
- A hard kill of the runtime, and a signal that ends it with no `exit` event, can still leave a tree. The operator ends it by hand.
- The exit handler blocks the exit for the length of one `taskkill` per live child.

## Alternatives

1. **A job object with kill-on-close**: it covers a hard kill, but Node has no API, and a helper binary or a native addon is a new dependency. Rejected for the cost.
2. **Rely on execa `cleanup`**: it leaves the tree alive on `process.exit`, as probed. Rejected.
3. **A host-wide scan for survivors**: it selects processes the runtime does not own (ADR 0017 item 4). Rejected.

## Authors

Andro Marces

## Links

- [Issue #612: Windows: nested process tree outlives a parent that exits before the execa timeout](https://github.com/andromarces/agent-loops/issues/612)
- [Issue #602: Verify the nested isolation tree kill](https://github.com/andromarces/agent-loops/issues/602)
- [ADR 0017: Run an operator test command before each reviewer turn](0017-run-a-test-command-before-each-reviewer-turn.md)
- Implementation: `killTreeOnExit` in `src/lib/exec-tree.mjs`, used in `src/lib/exec.mjs`, `src/lib/ci-gate.mjs`, `src/lib/snapshot.mjs`, and `src/lib/test-cmd.mjs`; test in `tests/lib/exec-tree.test.mjs`
- [ADR Index](README.md)
