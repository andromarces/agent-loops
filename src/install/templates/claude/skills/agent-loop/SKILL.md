---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
disable-model-invocation: true
argument-hint: <task and role settings>
---

@{{AGENT_LOOP_INSTRUCTIONS}}

Follow the attached instructions for this invocation. If the file is not
attached, read `__AGENT_LOOP_INSTRUCTIONS__` before acting. Run every
`agent-loop` command in the instructions as `__AGENT_LOOP_CLI__` instead, so the
run does not depend on the `agent-loop` command resolving on PATH. The task and
role settings from the invocation are:

$ARGUMENTS

Before the init dispatch call, run `__AGENT_LOOP_CLI__ harness-check claude`. It
exits 0 only when the nearest harness process above this shell is Claude Code.
If it exits 3, stop and report that another harness owns the session; do not
start a run. If it exits with any other non-zero code, stop and report that the
CLI could not run or could not read the harness ancestry, which is distinct from
a harness refusal. Do not use `${CLAUDE_SESSION_ID}` to make this decision,
because a foreign harness leaves the literal in place and a nested harness
inherits the value.

On the init dispatch call, pass ${CLAUDE_SESSION_ID} as `--parent-session`.
