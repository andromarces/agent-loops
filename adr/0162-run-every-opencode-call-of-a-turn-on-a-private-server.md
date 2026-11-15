# 0162. Run every OpenCode call of a turn on a private server

## Status

accepted

## Date

2026-11-16

## Context

An OpenCode worker turn could leave a detached `opencode.exe serve --service` process alive on
Windows after the turn ended. Its parent, the `opencode` shim, had exited, so the process outlived
the run. It held `codegraph serve --mcp` trees and an `opencode-pty.exe daemon`, and a work tree
removal then failed with `EBUSY` (issue #1992).

The adapter passed `--standalone` on the turn's `opencode run` only. The turn also starts a second
OpenCode process, `opencode session export <id>`, to read the resolved model (ADR 0026), and that
call passed no `--standalone`. Without the flag, the CLI connects to the shared background service,
and starts one when no service runs. The observed records place the process at the end of the first
worker turn: 15 s, and 2 s, before the turn ended, which is when the export runs. A later turn of
the same session started none, because the background service of the first turn still ran.

`killTree` ends a tree only for a live root on parent exit, and `taskkill /T` walks the parent links
of a live root, so a process whose root has exited is unreachable (ADR 0028).

## Decision

1. **The session export passes `--standalone`.** Every OpenCode call of a turn runs against a
   private server instead of the shared background service, so the turn starts no detached service
   process.
2. **A test covers every OpenCode call of a turn.** It asserts that each `opencode` invocation of a
   turn carries `--standalone`, so a later call cannot reintroduce the background service.
3. **No process-tree cleanup is added.** The turn starts no service to end, and a scan for
   `opencode serve` processes by name could end the host's own service or another run's.

## Consequences

- An OpenCode turn leaves no `opencode serve --service` process that it started.
- Provider variables set on the shared service with `opencode service set env` do not reach the
  export, as they already do not reach the run. They come from the process environment.
- The export keeps its cost and its failure handling (ADR 0026). A private server that fails to
  start fails the export, which leaves the resolved model unresolved.
- **Accepted gap:** a live OpenCode install on Windows was not run for this change. The CLI help of
  opencode v0.0.0-dev-1297 documents `--standalone` as "Run with a private server instead of the
  background service" on `session export`, and the test covers the argument only. The live check is
  tracked in issue #709.

## Alternatives

1. **End the service at turn end on Windows.** Rejected. The turn starts no service that it owns after
   this change, and a lookup by process name can end the OpenCode process of the host or of another
   run, which this turn runs under.
2. **Set an environment value that disables the background service.** Rejected. The installed CLI
   documents the `--standalone` flag and no such value, and an undocumented value breaks on an
   upgrade.

## Links

- [Issue #1992: An OpenCode worker turn leaves a detached opencode serve process alive on Windows](https://github.com/andromarces/agent-loops/issues/1992)
- [ADR 0026: Detect a changed resolved model on --continue-from](0026-detect-a-changed-resolved-model-on-continue-from.md)
- [ADR 0028: End the Windows process tree of a child when the runtime exits](0028-end-the-windows-process-tree-when-the-runtime-exits.md)
- [Implementation: OpenCode adapter](../src/agents/opencode.mjs)
- [Tests: OpenCode resolved model](../tests/agents/opencode.resolved-model.test.mjs)
- [ADR Index](README.md)
