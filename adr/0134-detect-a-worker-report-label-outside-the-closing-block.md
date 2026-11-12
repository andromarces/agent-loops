# 0134. Detect a worker report label that points outside the closing block

## Status

accepted

This ADR supersedes no earlier decision. It records the second choice of issue #1907: an envelope field names the label, and the parent dispatches one restatement turn.

## Date

2026-11-13

## Context

The worker prompt states that every result the parent needs stands inside the closing block. The worker never points at text outside it (#976). The parent reads only the envelope.

A worker turn on 2026-11-12 wrote `Why: the inference above, from the runner env`. The cause itself stayed in the response text before the block. The report held all six fields, so the parent had no sign that a result was missing. The runtime gave no field for that case.

## Decision

1. **Detect a parsed worker report only.** `outsideBlockReportLabels` in `src/lib/report.mjs` takes the child response and the parsed report. It returns the report label names whose value points at response text outside the closing block, in report order, for example `["Why"]`. A null report returns no label.
2. **Keep one small pattern list.** The list holds a noun phrase whose `above` ends the phrase, a verb before `above`, and a closing-block reference. A word after `above`, such as a comparison (`above target`) or a determiner and noun (`above the limit`), stays out. A value that names a report label points inside the block. The detection is a heuristic, and a pointer that the list misses stays undetected.
3. **Keep the documented exception.** The exception returns no label. Exactly one label points outside the block, and the response text before the block holds quoted text or at least two paragraphs. Quoted text is a blockquote line or a fenced code block. The rule comes from the closing-block text of `src/prompts/rules.mjs` and the worker prompt in `src/prompts/worker.mjs`.
4. **Name the labels in a new envelope field.** A parsed worker report with a match adds `reportOutsideBlockLabels` beside `reportMissingLabels`. It holds the label names only, never response text. A turn with no match carries no field. No other surface carries it.
5. **Leave the runtime turn flow unchanged.** The report stays in the envelope unchanged, and the step stays charged. The runtime starts no new turn.
6. **State the parent rule.** The orchestrator instructions and the headless prompt tell the parent to dispatch one worker turn for the named result. The field detail is in `docs/orchestrator/closing-block.md`, and the envelope field is in `docs/reference/role.md`. That keeps the core within its 50,000-byte bound.
7. **Leave reviewer turns unchanged.** A reviewer report with a pointer carries no field, and the reviewer path keeps its current shape.

## Consequences

- The parent learns the label that points outside the block without reading the child response.
- A pointer that the pattern list misses reaches the parent as an ordinary report. The field is a heuristic, not a proof that every result is inside the block.
- A matched turn costs one parent-dispatched restatement turn. The runtime charges no extra step for the detection.
- Reviewer turns and every other envelope keep their shape.

## Alternatives

1. **Run the bounded repair turn of #1615 on a match.** Not taken. The repair verifies label content against the original response, so a restated result from outside the block fails its match. The envelope field leaves the restatement to the parent.
2. **Widen the pattern list.** Not taken. A wide list names quantities and inside-block references, and a heuristic false positive costs a restatement turn.
3. **Change the report or add a parser shape.** Not taken. The report stays byte-identical, and the field only names the label.

## Authors

Andro Marces

## Links

- [Issue #1907](https://github.com/andromarces/agent-loops/issues/1907)
- [PR #1908](https://github.com/andromarces/agent-loops/pull/1908)
- [ADR 0094: Repair a null child closing block once in the same session](0094-repair-a-null-child-closing-block.md), related as the #1615 repair turn
- Implementation:
  - Detection: `outsideBlockReportLabels` in `src/lib/report.mjs`
  - Result field: `runChild` in `src/child-turn.mjs`
  - Envelope field: `dispatchPayload` in `src/role/dispatch.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/closing-block.md`, and `docs/reference/role.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/role/dispatch.reports.test.mjs`, and `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
