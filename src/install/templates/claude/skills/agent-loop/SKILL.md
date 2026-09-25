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

On the init dispatch call, pass ${CLAUDE_SESSION_ID} as `--parent-session`.
