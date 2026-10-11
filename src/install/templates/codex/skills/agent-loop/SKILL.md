---
name: agent-loop
description: Run a delegated agent-loop role orchestration when the user explicitly invokes $agent-loop.
# OpenCode also discovers ~/.agents/skills, lists this skill to the model, and
# the model auto-invokes it for an /agent-loop request. Hide it from OpenCode's
# model list so the installed OpenCode plugin command owns /agent-loop and
# supplies the session id.
metadata:
  opencode/autoinvoke: false
---

Read `{{AGENT_LOOP_INSTRUCTIONS}}` and follow it for this request. Run every
`agent-loop` command in the instructions as `__AGENT_LOOP_CLI__` instead, so the
run does not depend on the `agent-loop` command resolving on PATH.

{{HARNESS_CHECK}}

Use the invocation text as the task and role settings. Before the init dispatch
call, verify that the active shell has `CODEX_THREAD_ID`. Do not print its value.

In PowerShell, pass `$env:CODEX_THREAD_ID` as `--parent-session`. Set
`$worktree = (Get-Location).Path` and pass `--cwd $worktree`. Do not embed
`$PWD` in POSIX-style quotes. In POSIX shells, pass `--cwd "$PWD"` and
`$CODEX_THREAD_ID`. If it is absent, report the missing session channel and do
not start the run.
