---
name: agent-loop
description: Run a delegated agent-loop role orchestration through the agent-loop CLI. Invoke only with /agent-loop.
---

Read `{{AGENT_LOOP_INSTRUCTIONS}}` and follow it for this request. The file is a
core that is expected to fit in one read. When a read is capped, read again with
an offset until the end of the file. It names reference files to read when their
conditions hold. Run every
`agent-loop` command in the instructions as `__AGENT_LOOP_CLI__` instead, so the
run does not depend on the `agent-loop` command resolving on PATH.

{{HARNESS_CHECK}}

{{SESSION_CHANNEL}}
