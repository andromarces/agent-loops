# 0005. User-scope harness integrations only

## Status

accepted

## Date

2026-09-25

## Context

The harness entry points and parent-edit guards live in repository files (`.claude/`, `.agents/`, `.codex/`, `.opencode/`, `.github/hooks/`). They work only from a clone, and the npm package does not ship them (#139). An npm user has no supported entry point and no guard.

Workspace files also leak across harnesses. Antigravity CLI turns workspace `.agents/skills` into slash commands, so the Codex skill `.agents/skills/agent-loop` appears as `/agent-loop` in Antigravity sessions in this repository (#88). Copilot CLI reads the shared personal `~/.agents/skills`.

Probes on Windows (2026-09-25) confirmed a user-scope skill or plugin and a user-scope pre-tool hook for every supported harness: Claude Code, Codex CLI, OpenCode, GitHub Copilot CLI, and Antigravity CLI.

## Decision

Harness entry points and parent guards are installed at user scope only, by `agent-loop install`, and removed by `agent-loop uninstall`. After #139, no agent-loop entry point or guard exists at workspace level.

Implementation: #139 built the installer and removed the repository integrations. The repository files are gone; install is the only integration path.

1. The package ships the entry points and guards as templates. The templates are their only source.
2. Install renders each template with absolute paths into the running package. The package location comes from `import.meta.url`, not from the current directory.
3. The repository integration files are deleted once install works.
4. Clone users install the same way. A development setup runs `npm link` in the clone before `agent-loop install`, with the global prefix bin directory on `PATH`. After the clone moves, `npm link --force` and `agent-loop install` run again.
5. The Copilot session-id launcher from ADR 0003 stays: `agent-loop-copilot` mints one UUID, starts `copilot --session-id <uuid> --interactive <prompt>`, and passes the same id as `--parent-session`. Its guard moves from `.github/hooks/parent-guard.json` to a user hook file in `~/.copilot/hooks/`.

## Consequences

These consequences hold after #139 ships.

- An npm install gets the same entry points and guards as a clone.
- A harness no longer needs repository trust to load a guard. Codex still requires `/hooks` trust for each changed user hook.
- A clone without `agent-loop install` has no entry point and no guard.
- A development install ties user-scope files to one clone location. Moving the clone needs `npm link --force` and install again.
- The installer owns user settings entries and needs a manifest, byte-identical uninstall, and upgrade handling (#139).
- The shared `~/.agents/skills` folder exposes the Codex skill to Copilot CLI and OpenCode, and OpenCode also discovers `~/.claude/skills`. Each shared skill must identify the running harness by process ancestry: nested harnesses inherit session variables, and a foreign harness leaves `${CLAUDE_SESSION_ID}` unexpanded. Both the Codex and Claude skills refuse to start a run when the nearest harness process is not theirs. Each gate runs the installed CLI by absolute path, because Git Bash does not resolve the `agent-loop` `.cmd` shim; the skill uses that resolved invocation for every command in the instructions, exit code 3 means a harness refusal, and any other non-zero exit means the check could not run or found no harness ancestor (#151). Both shared skills set `metadata.opencode/autoinvoke: false`, so OpenCode drops them from the model's skill list and the model cannot auto-invoke one for an `/agent-loop` request; the OpenCode plugin command is then the only `/agent-loop` entry point that carries the OpenCode session id.
- Antigravity uses `~/.gemini/antigravity-cli/skills` and `~/.gemini/config/hooks.json`. Its hook `command` cannot contain a quoted or spaced path, so the guard runs through a shim in that folder.

## Alternatives

1. **Keep the repository integrations beside the user-scope install**: Both copies load inside this repository, so `/agent-loop` is defined twice, and the workspace Codex skill leaks into Antigravity.
2. **Repository integrations only (status quo)**: Leaves npm users without entry points or guards.
3. **Write workspace files into each project at install time**: Spreads agent-loop files into user repositories and needs repository trust per project.

## Authors

Andro Marces

## Links

- Supersedes [ADR 0003: GitHub Copilot CLI session entry point and parent guard](0003-copilot-session-entrypoint-and-parent-guard.md)
- [ADR 0002: Harness-neutral orchestrator instructions with thin entry points](0002-harness-neutral-orchestrator-instructions.md)
- [ADR 0004: Distribute the CLI as a scoped public npm package](0004-scoped-npm-distribution.md)
- [Issue #139: Interactive install and uninstall of harness entry points and parent guards](https://github.com/andromarces/agent-loops/issues/139)
- [Issue #88: Parent-edit guard and session-id entry point for Antigravity CLI](https://github.com/andromarces/agent-loops/issues/88)
- [PR #147: Use `npm link --force` for a moved clone and state the PATH requirement](https://github.com/andromarces/agent-loops/pull/147)
- [ADR Index](README.md)
