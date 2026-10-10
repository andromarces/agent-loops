# 0031. Refuse --resume-interrupted while a live process holds a Claude session

## Status

accepted

Supersedes decision 5 of [ADR 0029: Refuse --continue-from while a live process holds a Claude session](0029-refuse-continue-from-while-a-live-process-holds-a-claude-session.md). ADR 0029 stays `accepted`, because its other decisions hold. Both ADRs record the partial supersession.

## Date

2026-10-10

## Context

ADR 0029 decision 5 left the interactive `agent-loop role dispatch` path uncovered. It read the exposure from the code and asked for a probe before any check. A `role dispatch` process that a hard kill ends leaves its `claude` child alive, because both paths start the child through `exec`. The next dispatch marks the run `interrupted` and starts no child. `--resume-interrupted` then runs the turn with the kept session id, and the code held no check for a live holder.

The probe of issue #671 ran on macOS 27.2 (arm64), Node v26.11.1, Claude Code 2.1.296, with `haiku`, a scratch repository, and a separate `AGENT_LOOP_RUNS_ROOT` under the temporary directory. A `role dispatch --role worker` turn ran a Bash call that held for 70 seconds. `SIGKILL` to the dispatch pid only left the `claude` child alive with parent pid 1. The next dispatch printed `Previous turn ended uncertainly; state marked interrupted` and started no child.

Before the check, `--resume-interrupted` exited 0 with the kept session id while the orphan was alive. The session file grew from 20 to 40 lines during the resumed turn. After the resumed turn, the orphan wrote its tool result and its last assistant message to the same file, which ended at 52 lines, and its Bash call wrote its marker file. Both processes wrote the session.

## Decision

1. `agent-loop role dispatch --resume-interrupted` calls `refuseHeldSessions` (`src/lib/continuation.mjs`) with the dispatched role only. The call runs after the `interrupted` lifecycle check and before the step is charged and before `resumeDecision` is set.
2. The messages name the flag with `deps.flag: "--resume-interrupted"`. The error names the role, the id, and the pid. The exit code is 1.
3. A refusal leaves the lifecycle `interrupted`, charges no step, and starts no child, so the same call runs again after the holder ends.
4. Decisions 2, 3, 4, 6, and 7 of ADR 0029 apply unchanged: one bounded process-table read, UUID ids only, a failed read warns and continues, a failed read reports its reason class only, and the runtime neither waits for the holder nor ends it. A cancel of the read still cancels the dispatch.
5. The interactive instructions (`docs/orchestrator-instructions.md`) and the headless orchestrator prompt (`src/prompts/orchestrator.mjs`) state the same rule: the parent does not end the live holder, and the maintainer ends it or waits for it.

## Consequences

- With the check, the same probe sequence refused with exit 1 and `the worker session <id> is held by process <pid>`, and the orphan stayed alive. After the orphan ended, `--resume-interrupted` exited 0.
- The limits of ADR 0029 hold: a holder without the id in its command line is not found, the check and the resume are not atomic, and a fresh run in the same work tree is not covered.
- A resume checks only the role that it dispatches. The id of the other role is not read.
- The Windows command is not run on a Windows host.

## Alternatives

1. **Check at every dispatch**: rejected. Only `--resume-interrupted` reuses the id of a turn that ended uncertainly, so one check there covers the orphan, and a normal dispatch pays no process-table read.
2. **End the holder on the resume**: rejected for the reason of ADR 0029 alternative 2.

## Authors

Andro Marces

## Links

- [Issue #671](https://github.com/andromarces/agent-loops/issues/671)
- [Pull request #683](https://github.com/andromarces/agent-loops/pull/683)
- [ADR 0029: Refuse --continue-from while a live process holds a Claude session](0029-refuse-continue-from-while-a-live-process-holds-a-claude-session.md)
- Implementation: `dispatchLocked` in `src/role.mjs` and `refuseHeldSessions` in `src/lib/continuation.mjs`. Documented in `README.md` and `docs/orchestrator-instructions.md`.
- [ADR Index](README.md)
