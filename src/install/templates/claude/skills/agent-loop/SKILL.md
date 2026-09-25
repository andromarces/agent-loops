---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
disable-model-invocation: true
argument-hint: <task and role settings>
# OpenCode also discovers ~/.claude/skills, lists this skill to the model, and
# the model auto-invokes it for an /agent-loop request. Hide it from OpenCode's
# model list so the installed OpenCode plugin command owns /agent-loop and
# supplies the session id.
metadata:
  opencode/autoinvoke: false
---

@{{AGENT_LOOP_INSTRUCTIONS}}

Follow the attached instructions for this invocation. If the file is not
attached, read `__AGENT_LOOP_INSTRUCTIONS__` before acting. The task and role
settings from the invocation are:

$ARGUMENTS

Before the init dispatch call, run `agent-loop harness-check claude`. It exits 0
only when the nearest harness process above this shell is Claude Code. If it
exits non-zero, stop and report that another harness owns the session; do not
start a run. Do not use `${CLAUDE_SESSION_ID}` to make this decision, because a
foreign harness leaves the literal in place and a nested harness inherits the
value.

On the init dispatch call, pass ${CLAUDE_SESSION_ID} as `--parent-session`.
