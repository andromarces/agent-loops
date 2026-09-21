# 0002. Harness-neutral orchestrator instructions with thin entry points

## Status

accepted

## Date

2026-09-20

## Context

An interactive parent session can run the orchestrator role directly in a harness (Claude Code, OpenCode, Codex CLI, GitHub Copilot CLI, Antigravity CLI) instead of spawning the headless orchestrator. Duplicating the role rules per harness would let the copies drift, and placing role activation in `AGENTS.md` or `CLAUDE.md` is unsafe because dispatched children read those files and would activate the orchestrator role themselves.

Each harness documents its own custom-prompt and extension mechanisms (Claude Code skills, OpenCode commands and plugins), with no shared format across vendors.

## Decision

One harness-neutral instruction file (`docs/orchestrator-instructions.md`) defines the interactive orchestrator role; each supported harness gets a thin entry point that includes it rather than copying it.

1. Role activation happens only through explicit invocation (for example `/agent-loop`). It never goes into `AGENTS.md` or `CLAUDE.md`.
2. A native entry point is added for a harness only after that harness documents a custom-prompt mechanism; otherwise the universal fallback applies: the first prompt references the instruction file and the parent follows it.
3. An entry point passes the parent's own session id to the `agent-loop role` init call as `--parent-session`. Claude Code exposes it in the skill template (`${CLAUDE_SESSION_ID}`). OpenCode exposes no session id in a stored command template, so its entry point is a plugin command that reads `CommandInvocation.sessionID` and carries the id into the orchestrator prompt. A harness that exposes no session id at all omits the flag (see ADR 0001 consequences for the parent guard that consumes it).

## Consequences

- Claude Code ships a skill (`.claude/skills/agent-loop/SKILL.md`) with `disable-model-invocation: true`, so only the maintainer activates it; it passes `${CLAUDE_SESSION_ID}` as `--parent-session`.
- OpenCode ships a local plugin (`.opencode/plugins/parent-guard.ts`) that registers the `/agent-loop` command. The executor reads `CommandInvocation.sessionID`, so the init call passes `--parent-session` and the plugin's `permission` `evaluate` hook guards the parent. The stored command template is superseded; the plugin route needs no session placeholder.
- Codex CLI and Antigravity use the universal fallback until each documents a custom-prompt mechanism. GitHub Copilot CLI uses the session-keyed launcher and repository hook defined by ADR 0003.
- Role rules have exactly one source of truth; harness entry points never restate them, so a rule change is a one-file edit.

## Alternatives

1. **Duplicate role instructions per harness**: Guarantees drift between harnesses and multiplies the maintenance surface.
2. **Activate the role from `AGENTS.md`/`CLAUDE.md`**: Dispatched children read those files, so they would activate the orchestrator role and stop doing worker work.
3. **Headless orchestrator only**: Keeps a single entry point but loses the interactive session's context and requires no session-id plumbing; rejected because the interactive path is already shipped and used.

## Authors

Andro Marces

## Links

- [ADR 0001: Hybrid orchestrator with deterministic runtime](0001-hybrid-orchestrator-runtime.md)
- [Issue #56: Harness-neutral orchestrator instructions](https://github.com/andromarces/agent-loops/issues/56)
- [Issue #75: Wire the parent-edit guard for OpenCode through a plugin session-id channel](https://github.com/andromarces/agent-loops/issues/75)
- [Pull Request #80: feat: guard OpenCode parent edits through a plugin session-id channel](https://github.com/andromarces/agent-loops/pull/80)
- [ADR 0003: GitHub Copilot CLI session entry point and parent guard](0003-copilot-session-entrypoint-and-parent-guard.md)
- [Pull Request #59: feat: harness-neutral orchestrator instruction file with Claude Code skill and OpenCode command](https://github.com/andromarces/agent-loops/pull/59)
- [ADR Index](README.md)
