# 0101. Pin the OpenCode launch directory to the turn work tree

## Status

accepted

## Date

2026-11-08

## Context

A worker turn in a linked work tree edited a file of the main work tree, restored it, and continued (issue #1678). The worker report said its session started at the repository root. The adapter passed the run work tree as the `cwd` of `opencode run`, so the cause was not established.

An exported session of the failing turn shows its first location as the main checkout and a later `location-switched` message to the run work tree. The session still carried that first directory when the edit tool resolved `.github/workflows/ci.yml`.

A local probe on OpenCode v0.0.0-dev-973, Windows, 2026-11-08, used the `run` command with the run work tree as `cwd` and a loopback model server. With the inherited `PWD` set to the main checkout, the new session opened in the main checkout. With `PWD` set to the run work tree, the session opened in the run work tree. With `PWD` unset, it opened in the run work tree. The process working directory was the run work tree in every case.

OpenCode therefore reads the inherited `PWD` as its launch directory. A worker child inherits the operator shell's `PWD`, which names the main checkout, while `cwd` is the linked run work tree.

## Decision

1. **Pin `PWD`.** `runOpenCode` sets `PWD` to the turn `cwd` in the child environment. The value merges with the private turn temporary directory and the read-only `OPENCODE_CONFIG_CONTENT`. The adapter sets it only when the turn names a `cwd`.
2. **Stop on a worker report.** The orchestrator stops the run when a worker report says its edit landed in another checkout, reports the paths under `open` in the finish summary, and leaves that checkout to the user. It dispatches no turn to restore or continue it.
3. **Report-only field.** `mainWorkTreeChangedInTurn` stays report-only (ADR 0080, decision 6). A concurrent run can report the same path, so the runtime cannot attribute the edit to one run and does not stop a run on the field.

## Consequences

- An OpenCode session opens in the run work tree even when the operator shell's `PWD` names the main checkout.
- The fix covers every platform where `PWD` is set. An OpenCode build that ignores `PWD` falls back to the process working directory, which is already the run work tree.
- A worker can still reach another checkout through an absolute path that a tool returns. The worker report-and-stop rule and the orchestrator stop rule cover that case.
- The ADR 0080 fields keep their meaning, limits, and report action.

## Alternatives

1. **Clear `PWD` instead of setting it.** Rejected. The probe shows the process working directory as the fallback, but setting the value states the launch directory explicitly and keeps a shell that reads `PWD` consistent with `cwd`.
2. **Stop the run on `mainWorkTreeChangedInTurn`.** Rejected. The decision of issue #1678 and ADR 0080 decision 6 keep the field report-only, because all concurrent envelopes can name the same path.
3. **Rely on the worker report-and-stop rule alone.** Rejected. The failing turn restored the file and continued, so the rule alone did not stop it; the launch directory is fixed at the source.

## Authors

Andro Marces

## Links

- [Issue #1678](https://github.com/andromarces/agent-loops/issues/1678)
- [Issue #1551](https://github.com/andromarces/agent-loops/issues/1551)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md)
- Implementation: `runOpenCode` in `src/agents/opencode.mjs`
- Tests: `tests/agents/opencode.args.test.mjs`, `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
