# 0139. Name no outside-block label without outside text

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0135: Detect an outside-block report label for every child role](0135-detect-an-outside-block-report-label-for-every-child-role.md). The replaced parts are:

- Decision 2's rule that a worker pointer returns no label in one case. ADR 0139 adds a second case for every role, and a response with no text outside the block names no label.
- Decision 6's dispatch rule. ADR 0139 adds that the parent dispatches no restatement turn when the pointer names another label of the same report.

Decisions 1, 3, 4, and 5 of ADR 0135 stay in force. Decision 2's worker exception and its reviewer rule stay in force.

## Date

2026-11-13

## Context

Two worker turns on 2026-11-13 named a label whose pointer targeted an earlier label of the same report (issue #1918). The first turn held the `Checks` item `Mutation runs: all fail as listed above.`, and the list stood in `Why` of the same report. The envelope held `reportOutsideBlockLabels: ["Checks"]`. The restatement turn held a `Notes` value with `described above`, and the description stood in `Why` of the same report. Its envelope held `reportOutsideBlockLabels: ["Notes"]`.

Both reports parsed, so the envelopes hold no `raw`, and the response text before each block was not kept. Whether any text stood before the block is unknown.

The detection read a verb before `above` as a pointer to text outside the block, and it never asked whether outside text exists. A response that holds only the closing block has nothing outside the block for a pointer to reach.

## Decision

1. **Name no label without outside text.** `outsideBlockReportLabels` in `src/lib/report.mjs` returns no label when the response text before the closing block is empty or whitespace only. The rule applies to every child role (issue #1918).
2. **Keep the detection for a response with outside text.** A response with text before the block keeps the pattern list, the named-label rule, the worker exception, and the reviewer rule of ADR 0135.
3. **Read one stored value.** `runChild` in `src/child-turn.mjs` computes the field once, and the dispatch envelope, the state file, and the headless result read that stored value. This decision keeps ADR 0135 decision 4.
4. **State the parent rule.** The parent dispatches no restatement turn when the pointer names the content of another label of the same report that holds the result. The rule is in [Closing block list rules](../docs/orchestrator/closing-block.md#report-text-outside-the-block).

## Consequences

- Turn A and turn B carry no field, so the parent dispatches no restatement turn for them.
- A response with prose before the block keeps the origin/main field and the origin/main parent action.
- A pointer into the same report costs no turn when the block holds every result, and the runtime starts no new turn.
- The detection stays a heuristic over a pattern list, and a pointer that the list misses stays undetected.

## Scripted probe

The probe ran on 2026-11-13 on macOS with Node v27.0.0-alpha.0.1.0. It called the exported detection with the turn A and turn B shapes.

Before the change, turn A returned `["Checks"]` and turn B returned `["Notes"]`. After the change, both shapes return no label. A prose paragraph before each block still returns `["Checks"]` and `["Notes"]`.

## Alternatives

1. **Tell the child to name the label.** Not taken. The runtime rule removes the case, and the prompts keep their current text.
2. **Record the case as an accepted false positive.** Not taken. A value that reads a list of the same report costs no turn under the runtime rule.
3. **Widen the pattern list for a named label.** Not taken. A pointer that names another label stays a pointer under the origin/main detection, and the parent rule covers it.

## Authors

Andro Marces

## Links

- [Issue #1918](https://github.com/andromarces/agent-loops/issues/1918)
- [ADR 0134: Detect a worker report label that points outside the closing block](0134-detect-a-worker-report-label-outside-the-closing-block.md)
- [ADR 0135: Detect an outside-block report label for every child role](0135-detect-an-outside-block-report-label-for-every-child-role.md)
- Implementation:
  - Detection: `outsideBlockReportLabels` in `src/lib/report.mjs`
  - Result field: `runChild` in `src/child-turn.mjs`
  - Parent rule: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/child-turn.report-repair.test.mjs`, and `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
