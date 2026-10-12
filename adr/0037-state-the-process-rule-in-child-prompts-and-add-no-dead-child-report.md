# 0037. State the process rule in child prompts and add no dead-child report

## Status

accepted

## Date

2026-10-12

## Context

Issue #762: a worker turn ended its own run. It killed processes with a command-line match, and the dispatcher carries `--cwd <work tree>` in its command line. The match stopped the dispatcher and the CLI of the worker. The dispatch printed no envelope and exited 127. The state file stayed `dispatched` with no turn result.

The issue asks two questions:

1. Do the worker and reviewer prompts forbid a kill by name or by match?
2. Does the runtime also report a dispatch that ends with no recorded result and a dead child?

## Decision

1. The first worker turn and every reviewer turn state one shared rule (`processRule` in `src/prompts/report.mjs`): never stop, kill, or signal a process that the turn did not start, and never select processes by name or by a command-line match. End only the exact PIDs that the turn's own commands started.
2. The runtime adds no dead-child report. Three cases exist, and each already has a report:
   - The dispatcher survives and the child fails. `runChild` returns a handled error result (`status: "error"`). Dispatch records the turn and the result, leaves the lifecycle `active`, and returns the error message in the envelope with exit code 1.
   - A fatal error or a cancel throws out of `runChild`. Dispatch records the turn with status `error`, sets the lifecycle to `halted` (`interrupted` on a cancel), and returns exit code 1 (130 on a cancel).
   - The dispatcher dies, with or without the child. No code runs after the kill, so the dispatcher cannot write a cause. The state file stays `dispatched` with no turn result. The next `role dispatch` call records the turn as `interrupted`, marks the run `interrupted`, and reports "Previous turn ended uncertainly".

## Consequences

- A model that follows the prompt does not end the run by a match kill.
- The prompt rule is advisory. The runtime does not detect a breach, as with the remote-write rule of the reviewer.
- A killed dispatcher still leaves a bare exit code for that call. The parent reads the cause from the next call and from the state file.

## Alternatives

1. **Detect a dead child in the dispatcher**: rejected. The dispatcher already records a child failure. A killed dispatcher cannot detect anything.
2. **A watchdog process that reports a vanished dispatcher**: rejected. It adds a second process to the run and starts a new class of orphan and cleanup problems. The next call already reports the state.
3. **Block kill commands in the sandbox**: rejected. The runtime cannot tell a kill of an owned PID from a kill of another PID.

## Authors

Andro Marces

## Links

- [Issue #762: Forbid child turns from killing processes by name or command-line match](https://github.com/andromarces/agent-loops/issues/762)
- Implementation: `processRule` in `src/prompts/report.mjs`, `workerPrompt` in `src/prompts/worker.mjs`, `reviewerPrompt` in `src/prompts/reviewer.mjs`. The `dispatched` to `interrupted` path is in `src/role.mjs`.
- [ADR Index](README.md)
