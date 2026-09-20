# Architecture Decision Records

| ADR                                                       | Title                                                            | Status   | Summary                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [0001](0001-hybrid-orchestrator-runtime.md)               | Hybrid orchestrator with deterministic runtime                   | accepted | Replaces the fixed worker-first review loop with an LLM orchestrator that selects actions executed by a deterministic runtime. |
| [0002](0002-harness-neutral-orchestrator-instructions.md) | Harness-neutral orchestrator instructions with thin entry points | accepted | One instruction file defines the interactive orchestrator role; each harness gets a thin entry point that includes it.         |
