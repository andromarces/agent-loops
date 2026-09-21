# Architecture Decision Records

| ADR                                                         | Title                                                            | Status     | Summary                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [0001](0001-hybrid-orchestrator-runtime.md)                 | Hybrid orchestrator with deterministic runtime                   | accepted   | Replaces the fixed worker-first review loop with an LLM orchestrator that selects actions executed by a deterministic runtime. |
| [0002](0002-harness-neutral-orchestrator-instructions.md)   | Harness-neutral orchestrator instructions with thin entry points | superseded | One instruction file defines the interactive orchestrator role; ADR 0003 adds the Copilot session channel.                     |
| [0003](0003-copilot-session-entrypoint-and-parent-guard.md) | GitHub Copilot CLI session entry point and parent guard          | accepted   | The Copilot launcher and repository hook pass and enforce the parent session id.                                               |
