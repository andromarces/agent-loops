---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
---

Read `{{AGENT_LOOP_INSTRUCTIONS}}` and follow it for this request. Run every
`agent-loop` command in the instructions as `__AGENT_LOOP_CLI__` instead, so the
run does not depend on the `agent-loop` command resolving on PATH.

{{HARNESS_CHECK}}

Use the invocation text as the task and role settings. Before the init dispatch
call, verify that the active shell has `ANTIGRAVITY_CONVERSATION_ID`. Do not
print its value. In PowerShell, pass `$env:ANTIGRAVITY_CONVERSATION_ID` as
`--parent-session`. Set `$worktree = (Get-Location).Path` and pass
`--cwd $worktree`. Do not embed `$PWD` in POSIX-style quotes. In POSIX shells,
pass `--cwd "$PWD"` and `$ANTIGRAVITY_CONVERSATION_ID`. If the variable is
absent, report the missing session channel and do not start the run.
