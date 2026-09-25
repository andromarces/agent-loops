# 0006. Require a parent session id for interactive runs

## Status

accepted

## Date

2026-09-26

## Context

The parent-edit guard (#57) denies file-edit tools only when the hook session id
matches `parentSession` in the state file registered for that session. Init
treated `--parent-session` as optional, so a harness entry point that failed to
pass a session id started a run whose parent could never match: the guard fails
open and the interactive parent stays unguarded. `assertSessionId` also accepted
the literal `${CLAUDE_SESSION_ID}`, which registers an index entry that no
harness session id equals (#146, #149).

## Decision

1. Every `agent-loop role` init requires `--parent-session`. The subcommand
   refuses an init without it before any state file is written.
2. `assertSessionId` refuses a value that cannot be a real harness session id:
   an unexpanded placeholder (`${CLAUDE_SESSION_ID}`, `%CODEX_THREAD_ID%`,
   `<parent-session-id>`), a path separator, whitespace, backtick, or a
   relative-path token. Refusal happens in `statePaths` before any state file
   exists. A bare placeholder name with no punctuation (`CLAUDE_SESSION_ID`) is
   indistinguishable from a real token here; only a harness-id allowlist would
   catch it, which alternative 2 rejects.
3. The headless `agent-loop` command (no subcommand) is the explicit unguarded
   path. No unguarded path is the default.

## Consequences

- An interactive entry point that exposes no session id cannot start a `role`
  run. It either supplies one or uses the headless command.
- This amends [ADR 0002](0002-harness-neutral-orchestrator-instructions.md)
  item 3: the "a harness that exposes no session id omits the flag" clause is
  replaced by the requirement above. ADR 0002's harness-neutral decision stands.
- A legacy state file written without `parentSession` still allows every tool
  call; the guard keeps its fail-open behavior for records it cannot match.
- A real but unusual harness session id that contains a refused character would
  be rejected at init. No shipped harness id does.

## Alternatives

1. **Keep `--parent-session` optional and require an explicit `--unguarded`
   flag**: adds a flag and keeps an unguarded `role` path that a model can still
   select. Rejected; the headless command already is the explicit unguarded
   mode.
2. **Strict allowlist of known harness id shapes**: rejects an unknown but real
   harness id at init and would silently disable the guard on the hook side.
   Rejected; the placeholder check closes the reported path without that risk.

## Authors

Andro Marces

## Links

- [Issue #149: Reject an unexpanded session-id placeholder and decide whether a guarded run requires --parent-session](https://github.com/andromarces/agent-loops/issues/149)
- [PR #153: fix: require a parent session id and refuse placeholders (#149)](https://github.com/andromarces/agent-loops/pull/153)
- [ADR 0002: Harness-neutral orchestrator instructions with thin entry points](0002-harness-neutral-orchestrator-instructions.md)
- [ADR Index](README.md)
