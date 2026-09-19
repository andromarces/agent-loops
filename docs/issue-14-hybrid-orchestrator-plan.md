# Outcome: Hybrid orchestrator and deterministic runtime (issue #14)

| Field  | Value                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------ |
| Issue  | [#14](https://github.com/andromarces/agent-loops/issues/14) — closed                                         |
| Result | Delivered. Merged as [PR #18](https://github.com/andromarces/agent-loops/pull/18) (`0072d41`) on 2026-09-19. |
| ADR    | [adr/0001-hybrid-orchestrator-runtime.md](../adr/0001-hybrid-orchestrator-runtime.md) holds the decision.    |

The full implementation plan (443 lines) is superseded by the ADR, the merged PR description, and this stub. It is archived in the PR #18 branch history (`feat/issue-14-hybrid-orchestrator`).

## Acceptance evidence

- Three-CLI smoke run (`codex` orchestrator, `claude` worker, `agy` reviewer) finished with exit 0 and a five-part summary; full transcript written.
- Forced reviewer mutation exited 1 with `MutationError: mutated-by-reviewer.txt`; the file stayed in the work tree (no-revert rule).
- `codex exec resume <id> -c sandbox_mode="read-only"` accepted and honored on a resumed session.
- 110 tests passing, `pnpm lint` and `pnpm fmt:check` clean at merge. Full evidence in the PR #18 description.

## Unresolved follow-ups

None. Deferred items live in the README "Future additions" section.
