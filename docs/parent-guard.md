# Parent guard: hard read-only for the parent session

The parent rule ("the orchestrator never edits files") is prompt-only, so a drifting parent session can still edit. Five harnesses add a hard guard for the file-edit tools: Claude Code through a `PreToolUse` entry in `~/.claude/settings.json`, Codex CLI through a `PreToolUse` entry in `~/.codex/hooks.json`, OpenCode through a `permission` `evaluate` plugin hook, GitHub Copilot CLI through a user `PreToolUse` hook file in `~/.copilot/hooks/parent-guard.json`, and Antigravity CLI through a named `PreToolUse` group in `~/.gemini/config/hooks.json`. All share the decision logic in `src/hook/decision.mjs`, so they deny and release under the same rule.

- Matchers: Claude Code uses
  `Edit|Write|MultiEdit|NotebookEdit`. Codex CLI uses
  `apply_patch`, which its hook input reports as `tool_name: "apply_patch"`.
  Copilot CLI uses `Edit|Write`, which covers the current built-in edit and create
  tools. Antigravity CLI uses
  `write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|invoke_subagent|send_message`
  in its shipped `src/install/templates/antigravity/hooks.json` group.
  `Bash` stays allowed because the parent needs it to run `agent-loop role`;
  a shell-based edit bypasses all guards. Full enforcement needs a harness that
  exposes only orchestration tools.
- Subagent containment: Antigravity runs a subagent's tool calls under its own
  `conversationId`, and the hook payload names no parent. While guarded, the
  registered parent is denied on `invoke_subagent` (start a child) and
  `send_message` (message a child); `manage_subagents` stays allowed, so the
  parent can still list and terminate a child. A child active before the init
  call is outside the guard, because it runs under its own id.
- The hooks read the hook input on stdin and map the harness session field:
  `session_id` for Claude Code, Codex CLI, and Copilot CLI, and
  `conversationId` for Antigravity CLI. Claude Code and Codex CLI run
  `src/hook/parent-guard.mjs`, Copilot CLI runs
  `src/hook/copilot-parent-guard.mjs`, and Antigravity CLI runs
  `src/hook/antigravity-parent-guard.mjs`. They resolve the state file through
  the session index written by the init call, never through the hook `cwd`, so a
  parent whose run targets a different `--cwd` stays guarded wherever it edits.
  No environment variable is required at parent start-up; the harness entry
  points (#56) pass their session id as `--parent-session` on init.
- Deny only when the hook session id equals `parentSession` in the registered state and the lifecycle is non-terminal (`active`, `dispatched`, `interrupted`). The guard releases only on `finish`, `abort`, or a `halted` state; during `interrupted` it stays engaged, and `dispatch --resume-interrupted` keeps it engaged because the resumed run is non-terminal again.
- Everything else allows: a worker dispatched by `role` in the same cwd (a different session id), a second interactive session in the same cwd, a state without `parentSession`, and a missing or corrupt index entry or state file. The guard fails open by design: it supplements the prompt-only rule, so an unknown record never blocks a tool call.
- Without a state file the hook does one absent-file read, prints nothing, and exits 0; the normal permission flow applies. The deny reason names orchestrator mode and points at `role dispatch` / `finish` / `abort`.
- The installed Claude entry is a shell-form `command` with no `args`,
  `node "<installed guard path>"`. Claude Code runs it through a shell. The user
  settings file is Claude-only: Copilot CLI reads the shared subset of a
  _repository_ `.claude/settings.json`, not a user one, so Copilot gets its own
  user hook file.
- On OpenCode, `~/.config/opencode/plugins/parent-guard.ts` registers a `permission` `evaluate` hook. It reads `PermissionEvaluation.sessionID`, resolves the state through the same session index, and sets `effect: "deny"` with the same reason under the same rule. A live probe against OpenCode v0.0.0-dev-19933 showed the `edit`, `write`, and `apply_patch` tools all raise the `edit` action, so the guard's action set (one set entry, `edit`) covers every built-in file-edit tool; a tool served by an MCP server raises its own action name and passes the guard. `shell` raises a different action and stays allowed, as `Bash` does on Claude Code. The guard exists only while the plugin is loaded, so a session that disables it stays unguarded.
- The plugin runs inside the OpenCode server process, so it resolves `AGENT_LOOP_RUNS_ROOT` from that process's environment; the Claude Code hook inherits the parent shell's environment instead. The override is test-only, but using it outside tests would point the plugin and the `agent-loop` CLI at different roots and disable the guard silently.
- On Antigravity CLI, `src/hook/antigravity-parent-guard.mjs` reads `conversationId` and `toolCall.name`, reuses `decideParentGuard`, and prints `{"decision":"deny","reason":...}` only for a guarded tool call from the registered parent. Antigravity blocks a tool call when a hook prints `{}`, prints an empty decision, or exits non-zero, so every allow path prints nothing and exits 0 and keeps the normal permission flow. The global `~/.gemini/config/hooks.json` group runs a shim in that folder by a flat relative path, and the shim imports the guard by `file:///` URL, because a quoted or spaced absolute script path fails in every quoting form tested. A stale or unreachable guard URL is swallowed, so a moved package or deleted file does not fail closed. The parent learns its id from the undocumented `ANTIGRAVITY_CONVERSATION_ID`, which child processes inherit.

## Pre-tool hook availability by harness

Surveyed 2026-09-21 against current vendor docs, current binaries, and the installed Copilot CLI 1.0.87-0 binary; Antigravity re-surveyed 2026-09-25 on CLI 1.2.10. A session-keyed guard needs both a pre-tool hook and a way for the parent to learn its own session id at init time; the guard ships only where both exist.

| Harness            | Pre-tool hook                                                                                                                       | Guard                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Claude Code        | `PreToolUse`, deny supported, `session_id` in input                                                                                 | Implemented (user scope)  |
| Codex CLI          | `PreToolUse`, deny supported, `session_id` in input; entry point depends on undocumented `CODEX_THREAD_ID`                          | Implemented (best effort) |
| Antigravity CLI    | Global named `PreToolUse` group in `~/.gemini/config/hooks.json`, deny supported, `conversationId` and `toolCall.name` in input     | Implemented (user scope)  |
| GitHub Copilot CLI | PascalCase `PreToolUse`, deny supported, `session_id` and `tool_name` in input; user `~/.copilot/hooks/*.json` loads in current CLI | Implemented (user scope)  |
| OpenCode           | `permission` `evaluate` plugin hook can set `deny`; event carries `PermissionEvaluation.sessionID`                                  | Implemented (user scope)  |

Codex CLI now uses its `PreToolUse` hook with the session id in hook input. Its
entry point relies on `CODEX_THREAD_ID` from the shell environment, which is not
documented and can break on upgrade, and on the installed CLI's `harness-check
codex` command to confirm the running harness. The guard fails open when the
variable is absent or unusable. Antigravity CLI now has a user-scope skill and
a global `PreToolUse` group, both keyed on the undocumented
`ANTIGRAVITY_CONVERSATION_ID`; the guard
fails open when the variable is absent or unusable.
Copilot uses the documented session-keyed launcher and its user hook file
described above. OpenCode has both: a command reads
`CommandInvocation.sessionID`, and the permission hook reads
`PermissionEvaluation.sessionID`.

The guard path blocked `apply_patch` on Codex CLI 0.156.0-alpha.14 for this
Windows check. This is a known-good runtime, not a stable minimum version.
Codex hook denial was not enforced in CLI 0.133.0 or Desktop 0.138.0-alpha.7.
See [openai/codex#27833](https://github.com/openai/codex/issues/27833). Verify
that the installed Codex version blocks `apply_patch` before relying on this
guard. The hook is a best-effort guardrail, not a complete enforcement boundary.

The full skill-to-edit check passed on Codex CLI 0.157.0-alpha.1 on Windows: the
`$agent-loop` skill registered the Codex thread as the parent, `apply_patch`
returned `GUARD_DENY_REASON`, `role abort` set the lifecycle to `aborted`, and
`apply_patch` then succeeded. The probe ran with
`sandbox_mode = "danger-full-access"`; the `role finish` release path is covered
by `tests/hook/parent-guard.test.mjs`. The `workspace-write` leg stays
unverified on Windows: Codex's unelevated Windows sandbox blocks the child
`git` spawn (`EPERM`) before run initialization
([openai/codex#37415](https://github.com/openai/codex/issues/37415)). The same
sandbox blocks `harness-check codex` (run through the installed CLI), because
the process ancestry read spawns `powershell.exe` and hits `spawn EPERM`; the
check exits 1 and the skill stops with a check that could not run. That stop is
safe, and it is a second blocker
beside the init `git` spawn. Run that leg on macOS or Linux, or under the
elevated Windows sandbox.
The `ps` ancestry read under the macOS Codex sandbox is not tested.
