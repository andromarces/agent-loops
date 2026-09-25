---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
disable-model-invocation: true
argument-hint: <task and role settings>
---

@{{AGENT_LOOP_INSTRUCTIONS}}

Follow the attached instructions for this invocation. If the file is not
attached, read `__AGENT_LOOP_INSTRUCTIONS__` before acting. The task and role
settings from the invocation are:

$ARGUMENTS

Before the init dispatch call, run `__AGENT_LOOP_CLI__ harness-check claude`. The
absolute invocation runs in Git Bash and PowerShell alike, so it never depends on
the `agent-loop` command resolving on PATH. It exits 0 only when the nearest
harness process above this shell is Claude Code. If it exits non-zero, stop and
report that another harness owns the session; do not start a run. If the command
cannot run at all, stop and report the missing CLI, which is distinct from a
harness refusal. Do not use `${CLAUDE_SESSION_ID}` to make this decision, because
a foreign harness leaves the literal in place and a nested harness inherits the
value.

On the init dispatch call, pass ${CLAUDE_SESSION_ID} as `--parent-session`.
