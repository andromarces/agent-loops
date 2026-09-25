---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
---

Read `__AGENT_LOOP_INSTRUCTIONS__` and follow it for this request.

Before the init dispatch call, run `__AGENT_LOOP_CLI__ harness-check antigravity`.
The absolute invocation runs in Git Bash and PowerShell alike, so it never
depends on the `agent-loop` command resolving on PATH. It exits 0 only when the
nearest harness process above this shell is Antigravity CLI. If it exits
non-zero, stop and report that another harness owns the session; do not start a
run. If the command cannot run at all, stop and report the missing CLI, which is
distinct from a harness refusal. Do not use `ANTIGRAVITY_CONVERSATION_ID` to make
this decision, because a nested harness inherits it.

Use the invocation text as the task and role settings. Before the init dispatch
call, verify that the active shell has `ANTIGRAVITY_CONVERSATION_ID`. Do not
print its value. In PowerShell, pass `$env:ANTIGRAVITY_CONVERSATION_ID` as
`--parent-session`. Set `$worktree = (Get-Location).Path` and pass
`--cwd $worktree`. Do not embed `$PWD` in POSIX-style quotes. In POSIX shells,
pass `--cwd "$PWD"` and `$ANTIGRAVITY_CONVERSATION_ID`. If the variable is
absent, report the missing session channel and do not start the run.
