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

Read `{{AGENT_LOOP_INSTRUCTIONS}}` in full before acting, and follow it for this
invocation. The file is a core that is expected to fit in one read, but when a
read is capped, read again with an offset until the end of the file. It names
reference files to read when their conditions hold. Run every
`agent-loop` command in the instructions as `__AGENT_LOOP_CLI__` instead, so the
run does not depend on the `agent-loop` command resolving on PATH. The task and
role settings from the invocation are:

$ARGUMENTS

{{HARNESS_CHECK}}

On the init dispatch call, pass ${CLAUDE_SESSION_ID} as `--parent-session`.
