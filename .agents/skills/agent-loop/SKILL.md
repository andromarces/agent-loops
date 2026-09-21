---
name: agent-loop
description: Run a delegated agent-loop role orchestration when the user explicitly invokes $agent-loop.
---

Read `docs/orchestrator-instructions.md` and follow it for this request.

Use the invocation text as the task and role settings. Before the init
dispatch call, verify that the active shell has `CODEX_THREAD_ID`. Do not print
its value. Pass that environment value as `--parent-session`, using the active
shell's syntax. If it is absent, report the missing session channel and do not
start the run.
