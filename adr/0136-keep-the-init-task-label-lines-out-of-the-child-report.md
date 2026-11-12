# 0136. Keep the init task label lines out of the child report

## Status

accepted

This ADR supersedes no earlier decision. It records the first choice of issue #1909: a prompt rule at the init task block, in place of the detection path.

## Date

2026-11-13

## Context

A worker envelope can carry a parsed report whose values come from the `Init task:` block (issue #1909). The parser starts the closing block at the last `Conclusion:` line, so it reads the child's own block. A scripted response with the task label lines and a second block parsed to the task `conclusion` and `why`. Its `checks` and `notes` came from the turn. That shape matches the observed opencode envelope. The cause is the child prompt, not the parser.

## Decision

1. **State the rule where the block renders.** `initTaskBlock` in `src/prompts/rules.mjs` renders the block for a worker and reviewer first turn. It adds the rule above the block.
2. **Keep the parser and the report shape.** The parser still reads the child's own block, and no envelope field is added.
3. **Keep every guard and gate.** The #1615 repair, the reviewer verdict rule, both accept gates, and the OpenCode fail-closed guard keep their behavior.
4. **Reject the detection path for this cause.** The detection path relies on the #1615 repair. `repairedReportMatches` requires each label to keep the normalized content of the original response. A repair that replaces a copied task value with a turn value fails that match, so the repaired report is unused.
5. **Take the detection path only on a new live failure.** A live turn that still copies a task value needs its own decision and its own design.

## Consequences

- A first turn whose task holds label lines gets the rule before it reads the block.
- The report keeps its shape and its repair turn.
- A later turn still holds the task text in its conversation, and this rule does not reach it.
- The parser needs no change, so no accepted shape is lost.

## Live check

Run on 2026-11-13 on macOS 27.3 build 26C5035r with Node v27.0.0-alpha.0.1.0.

- The source was commit `7a470cee` plus the change of this ADR.
- Each CLI ran one `role dispatch` worker turn in a new disposable Git repository outside every work tree.
- `AGENT_LOOP_RUNS_ROOT` named a folder in the system temporary directory.
- The task held `Conclusion: TASK-LABEL-CONCLUSION-710`, `Why: TASK-LABEL-WHY-710`, `Checks: TASK-LABEL-CHECKS-710`, and `Verdict: accept`.
- The prompt asked for `dispatch-marker.txt` and no `notes.txt`.
- Each nested run ended with `role abort`.

- **opencode v0.0.0-dev-1248**, requested model `opencode-go/deepseek-v4.1-flash`.
  - The turn exited 0 and created `dispatch-marker.txt`.
  - The report held a conclusion from the turn and no task label value in any field.
  - The `notes` field named the task conflict.
- **GitHub Copilot CLI 1.0.110-3**, a write prompt.
  - The turn exited 0 with no file and `shellDenied: true`.
  - The report described the denied write and held no task label value.
- **GitHub Copilot CLI 1.0.110-3**, a read prompt for `seed.txt`.
  - The turn exited 0 and the report named `seed-value-1909`.
  - No field held a task label value.

- Not verified: codex-cli, agy, a later turn, and a Windows or Linux host.

## Alternatives

1. **Run the #1615 repair on a copied value.** Not taken. Decision 4 records the match rule that rejects a repaired turn value.
2. **Change the parser.** Not taken. The parser reads the child's own block, and the observed report came from the child.
3. **Add an envelope field for the copied label.** Not taken. The prompt rule removes the cause, and a field adds a parent turn.

## Authors

Andro Marces

## Links

- [Issue #1909](https://github.com/andromarces/agent-loops/issues/1909)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- [ADR 0105: Keep probe evidence in the linked issue or ADR](0105-keep-probe-evidence-in-the-linked-issue-or-adr.md)
- [ADR 0134: Detect a worker report label that points outside the closing block](0134-detect-a-worker-report-label-outside-the-closing-block.md)
- Implementation:
  - Prompt rule: `initTaskBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/task-delivery.md` and `docs/reference/role.md`
  - Tests: `tests/prompts/rules.test.mjs`
- [ADR Index](README.md)
