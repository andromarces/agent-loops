# 0135. Detect an outside-block report label for every child role

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0134: Detect a worker report label that points outside the closing block](0134-detect-a-worker-report-label-outside-the-closing-block.md). The replaced parts are:

- Decision 1's worker-only detection. `runChild` now runs the same detection for every parsed report.
- Decision 4's worker-only envelope field and its rule that no other surface carries the field. A reviewer envelope and the headless result carry it too.
- Decision 7's rule that reviewer turns stay unchanged. A reviewer turn now names the label.

Decisions 2, 3, 5, and 6 stay in force. Decision 3's exception applies to a reviewer turn, for the reason in decision 2 below.

## Date

2026-11-13

## Context

The worker path names a report label whose value points at response text outside the closing block (ADR 0134, issue #1907). The reviewer path kept its old shape. A reviewer can write `Why: the defects above`, and the parent then reads a report with no defect.

The reviewer prompt in `src/prompts/reviewer.mjs` shares the closing-block text of `src/prompts/rules.mjs`. That text places quoted or multi-paragraph text before the block and lets one label refer to it. The reviewer prompt therefore documents the same exception as the worker prompt.

## Decision

1. **Detect a parsed report of every role.** `outsideBlockReportLabels` in `src/lib/report.mjs` keeps its signature and its pattern list. `runChild` in `src/child-turn.mjs` calls it for every parsed report, whether the role is worker or reviewer.
2. **Keep the documented exception for both roles.** The reviewer prompt shares the closing-block text that documents the exception. A matching pointer returns no label in one case. Exactly one label points outside the block, and the text before it holds quoted text or at least two paragraphs.
3. **Name the labels on both envelopes.** A parsed report with a match adds `reportOutsideBlockLabels` to a worker or reviewer envelope. The field holds label names only, never response text. A turn with no match carries no field.
4. **Read one stored value.** `runChild` stores the result field once. The dispatch envelope and the headless result prompt read that stored value.
5. **Leave the turn flow unchanged.** The report, the verdict, the repair turn, the step charge, and both accept gates keep their shape. A reviewer accept with the field stays an accept.
6. **State the parent rule.** The docs tell the parent to dispatch one turn of the same role for the named result. The envelope detail is in `docs/orchestrator/closing-block.md`, and `docs/reference/role.md` names the field.

## Consequences

- The parent learns a reviewer label that points outside the block without reading the child response.
- A reviewer accept with the field still ends the finish gate as an accept.
- A pointer that the pattern list misses reaches the parent as an ordinary report. The field is a heuristic, not a proof that every result is inside the block.
- The runtime starts no new turn and charges no extra step for the detection.

## Alternatives

1. **Keep the detection worker-only.** Not taken. A reviewer pointer then reaches the parent with no sign that a result is missing.
2. **Drop the exception for a reviewer turn.** Not taken. The reviewer prompt shares the closing-block text that documents the exception, so the prompt and the detector disagree.
3. **Add a second detector or a role option.** Not taken. One function and one pattern list cover both roles.

## Authors

Andro Marces

## Links

- [Issue #1910](https://github.com/andromarces/agent-loops/issues/1910)
- [ADR 0134: Detect a worker report label that points outside the closing block](0134-detect-a-worker-report-label-outside-the-closing-block.md)
- Implementation:
  - Detection: `outsideBlockReportLabels` in `src/lib/report.mjs`
  - Result field: `runChild` in `src/child-turn.mjs`
  - Envelope field: `dispatchPayload` in `src/role/dispatch.mjs`
  - Headless result: `resultPrompt` in `src/prompts/orchestrator.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/closing-block.md`, and `docs/reference/role.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, `tests/role/dispatch.reports.test.mjs`, `tests/runtime.require-accept.test.mjs`, `tests/prompts/orchestrator.test.mjs`, and `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
