# 0136. Keep the init task label lines out of the child report

## Status

partially-superseded

This ADR is partially superseded by [ADR 0137: Name a report value copied from the init task](0137-name-a-report-value-copied-from-the-init-task.md). The superseded parts are:

- Decision 5's rule that the plain-prose limit stays and the prompt rule is the only barrier.
- The third consequence's rule that a plain task quotation still parses as a block with the prompt rule as the mitigation.
- Alternative 3's rejection of an envelope field for the copied label.

Decisions 1, 2, 3, 4, and 6 stay in force.

This ADR supersedes no earlier decision. It records the choices of issue #1909: a parser fix for a fenced quotation and a prompt rule at the init task block.

## Date

2026-11-13

## Context

A worker envelope can carry a parsed report whose values come from the `Init task:` block (issue #1909).

A scripted response reproduced the parser cause. The response held the task label lines in a fenced code block, then a turn description. `parseReportBlock` returned `TASK-LABEL-CONCLUSION-710` as the conclusion. The turn description alone returned no report.

The parser started the block at a `Conclusion:` line inside the fence. The closing-block contract states that a label in a fenced code block stays out. The same response with the task lines in a blockquote returned no report.

A plain quotation of the task lines at column 0 stays indistinguishable from a valid block. The parser takes the last `Conclusion:` line as the block start. The prompt rule is the only barrier for that shape.

The issue envelope held report values equal to the task values, and no saved record holds the raw response. The prompt rule states that the block is task data, and the live check below records that result.

A fenced `Verdict:` line had the same defect on `origin/main`. A real `Verdict: reject` followed by a fenced `Verdict: accept` returned accept, and `acceptanceFailure` returned null. The fix keeps every fenced line out of the verdict too.

The guard also needs the old block start. A split fenced task quotation holds no unfenced `Conclusion:` line, and the old start scan found the fenced one. The guard keeps that scan, and the report and the gates keep the fence-free scan.

## Decision

1. **Skip a fenced line in the parser.** `closingBlock` in `src/lib/report.mjs` ignores a `Conclusion:` line inside a fence. It blanks every fenced line for the report and the verdict, so a quoted label or verdict supplies no value.
2. **Keep the split guard closed.** `guardVerdict` keeps the `origin/main` block start and reads a fenced line for the OpenCode guard. Every stream that the old guard refused still refuses, and no gate reads that value.
3. **Keep the first-turn prompt rule.** `initTaskBlock` in `src/prompts/rules.mjs` states that the block is task data, not the closing block. Worker and reviewer first turns render it.
4. **Keep every other parser rule and assertion.** The accepted shapes and the last-occurrence rule stay. The list folds, the repair, the valid verdict shapes, both accept gates, and the OpenCode guard also stay.
5. **Record the plain-prose limit.** A plain task quotation at column 0 has no quotation mark that the parser can read. It stays indistinguishable from a valid block, and the prompt rule covers that shape.
6. **Reject the detection path.** The #1615 repair requires each label to keep the original response content. A repair that replaces a copied value fails that match, so the repair is unused.

## Consequences

- A fenced task quotation never becomes a report value, and a real block beside it keeps its own values.
- A blockquote label already stayed out, and the scripted probe records that result.
- A plain task quotation at column 0 still parses as a block. The prompt rule is the mitigation, and the limit stays documented.
- A quoted verdict never passes an accept gate, and a response whose only verdict is fenced has none.
- The OpenCode guard refuses every stream that it refused on `origin/main`, and the comparison probe records each pair.
- The report shape, the repair turn, and every gate keep their behavior.

## Live check

Run on 2026-11-13 on macOS 27.3 build 26C5035r with Node v27.0.0-alpha.0.1.0. The live turns ran with the prompt rule only. The parser, verdict, and guard probes ran on the final change from commit `7a470cee`.

- Each CLI ran one `role dispatch` worker turn in a new disposable Git repository outside every work tree.
- `AGENT_LOOP_RUNS_ROOT` named a folder in the system temporary directory.
- The task held `Conclusion: TASK-LABEL-CONCLUSION-710`, `Why: TASK-LABEL-WHY-710`, `Checks: TASK-LABEL-CHECKS-710`, and `Verdict: accept`.
- The unsteered prompt asked for `dispatch-marker.txt` and no `notes.txt`.
- Each nested run ended with `role abort`.

- **opencode v0.0.0-dev-1248**, requested model `opencode-go/deepseek-v4.1-flash`.
  - The turn exited 0 and created `dispatch-marker.txt`.
  - The report held a conclusion from the turn and no task label value in any field.
  - The `notes` field named the task conflict.
- **GitHub Copilot CLI 1.0.110-3**, a write prompt.
  - The turn exited 0 with no file and `shellDenied: true`.
  - The report described the denied write and held no task label value.

- The scripted parser probe held the task label lines in a fence, then a turn description. `parseReportBlock` returned null after the fix.
- The same task lines in a blockquote also returned null.
- The same task lines as plain earlier prose returned `TASK-LABEL-CONCLUSION-710`. That shape has no quotation mark, so the parser cannot tell it from a valid block.
- The verdict probe paired a real `Verdict: reject` with a fenced `Verdict: accept`. It returned reject after the fix, and `acceptanceFailure` returned verdict.
- The mirror pair with a real accept and a fenced reject returned accept.
- A response whose only verdict sat in a fence returned unknown.
- The guard comparison covered seven streams. They were one part, two identified parts, plain labels, bold labels, a split verdict, a fence across parts, and a fence inside one part.
- Every pair was equal, and the new guard refused no fewer streams than the old one.

- Not verified: codex-cli, agy, a later turn, and a Windows or Linux host.

## Alternatives

1. **Run the #1615 repair on a copied value.** Not taken. Decision 6 records the match rule that rejects a repaired turn value.
2. **Drop a plain label line that sits after narration.** Not taken. A plain `Conclusion:` line is also the valid block start.
3. **Add an envelope field for the copied label.** Not taken. The parser fix and the prompt rule remove the cause, and a field adds a parent turn.

## Authors

Andro Marces

## Links

- [Issue #1909](https://github.com/andromarces/agent-loops/issues/1909)
- [PR #1912](https://github.com/andromarces/agent-loops/pull/1912)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md)
- [ADR 0105: Keep probe evidence in the linked issue or ADR](0105-keep-probe-evidence-in-the-linked-issue-or-adr.md)
- [ADR 0134: Detect a worker report label that points outside the closing block](0134-detect-a-worker-report-label-outside-the-closing-block.md)
- Implementation:
  - [Implementation: report parser](../src/lib/report.mjs)
  - [Implementation: OpenCode split guard](../src/agents/opencode-text.mjs)
  - [Implementation: init task block](../src/prompts/rules.mjs)
  - [Implementation: closing-block docs](../docs/orchestrator/closing-block.md)
  - [Implementation: task delivery docs](../docs/orchestrator/task-delivery.md)
  - [Implementation: role reference](../docs/reference/role.md)
  - [Implementation: parser tests](../tests/lib/report.test.mjs)
  - [Implementation: OpenCode stream tests](../tests/agents/opencode.stream.test.mjs)
  - [Implementation: prompt tests](../tests/prompts/rules.test.mjs)
- [ADR Index](README.md)
