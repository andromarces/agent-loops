---
description: Run a delegated agent-loop role orchestration through the agent-loop CLI (rules in docs/orchestrator-instructions.md).
---

Read `docs/orchestrator-instructions.md` and follow it for this request. The
task and role settings are:

$ARGUMENTS

OpenCode exposes no parent session id in command templates, so omit
`--parent-session` on the init dispatch call.
