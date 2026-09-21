# 0003. GitHub Copilot CLI session entry point and parent guard

## Status

accepted

## Date

2026-09-21

## Context

The interactive orchestrator needs the parent session id at init time so the shared parent-edit guard can distinguish the parent from workers and other sessions. GitHub Copilot CLI exposes `--session-id` for a new session and exposes `session_id` to PascalCase `PreToolUse` command hooks, but its documented project customization surfaces do not provide a custom command template with a session-id placeholder.

This decision extends [ADR 0002](0002-harness-neutral-orchestrator-instructions.md) with the Copilot-specific session channel and entry point.

## Decision

Use a cross-platform Node entry point, exposed as `agent-loop-copilot`, to mint one UUID, start `copilot --session-id <uuid> --interactive <prompt>`, and include the instruction file, task, and the same id for `--parent-session` in the first prompt. Register a repository-level `.github/hooks/parent-guard.json` using PascalCase `PreToolUse` with the `Edit|Write` matcher. The hook reads `session_id`, reuses `decideParentGuard`, and returns Copilot's flat `permissionDecision` response.

## Consequences

- Trusted Copilot CLI sessions receive the same session-keyed parent-edit guard as Claude Code and OpenCode.
- The Copilot hook covers the built-in file create and edit tools represented by `Write` and `Edit`. Shell and MCP tools remain outside the guard.
- The hook remains fail-open for malformed input, absent or corrupt state, terminal lifecycles, and lookup errors.
- Users need to trust the repository before Copilot CLI loads repository hooks. The current repository hook location is documented for Windows, macOS, and Linux.

## Alternatives

1. **Universal fallback prompt**: Omits `--parent-session`, so the parent remains unguarded.
2. **A custom command template**: The current Copilot CLI documentation exposes no session-id placeholder for a repository command template.
3. **A user-level hook**: Requires per-user installation and does not travel with the repository.

## Authors

Andro Marces

## Links

- [Issue #87: Wire the parent-edit guard and a session-id entry point for GitHub Copilot CLI](https://github.com/andromarces/agent-loops/issues/87)
- [ADR 0002: Harness-neutral orchestrator instructions with thin entry points](0002-harness-neutral-orchestrator-instructions.md)
- [Copilot CLI hook configuration](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Implementation: Copilot entry point](../src/entrypoints/copilot.mjs)
- [Implementation: Copilot parent guard hook](../src/hook/copilot-parent-guard.mjs)
