# 0167. Fold a second dash list and a prose line under one closing-block label

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md). The replaced part is the "prose between two lists" item of decision 3. The other decisions stay in force, and so does every other rejection of decision 3.

## Date

2026-11-18

## Context

Issue #2005 recorded a Claude worker report with two `Why:` dash lists and a prose line between them. `parseReportBlock` at `ffaf28d0` returned null for that shape, so the parent read `raw`.

A probe at `ffaf28d0` replayed the six shapes from the issue. The plain list, the list and prose pair, and the blank line and list all parsed. The list and second list, the full issue shape, and the list and prose and list without blank lines returned null.

The issue offers a fold or a prompt bar. The fold follows [ADR 0140](0140-fold-every-closing-block-list-level.md), which folds every list level and every one-blank-line shape that #1917 reported.

## Decision

1. **Fold a second dash list after one blank line.** A `- ` run under a label joins the label value with `; ` after one blank line, as the first run does. Two blank lines, an ordered second run, a repeated label, and a prose line that reads as a label still refuse.
2. **Fold a plain prose line and its dash list across one blank line.** The prose line and its `- ` items join the label above as `<prose>: <items>`. A whole-line bold heading keeps its rule: its list must sit directly under it.
3. **Apply the fold once.** The shared parse in `src/lib/report.mjs` serves the dispatch envelope, interactive `role finish --require-accept`, and headless `runLoop` with `requireAccept` true.
4. **Keep every other rejection.** A decorated label and a list after the reviewer `Verdict:` line stay unparseable. A prose line with a label name, a two-blank-line gap, and an ordered list under a prose line also stay unparseable.
5. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` and `docs/orchestrator/closing-block.md` state both new folds.

## Consequences

- The issue #2005 shape parses, and every item of both dash lists and the prose line stays in the value.
- The replay row with no blank lines before the prose stays null, because the prose fold needs the blank line above.
- A second dash list with two blank lines before it still fails closed into `raw`.
- The dispatch envelope, the interactive gate, and the headless gate read the same report, because all three use the shared parse.
- A repair turn no longer treats the second dash list as a defect that needs no content change.

### Probe

- The probe ran `parseReportBlock` from source `ffaf28d0` on the six issue shapes. Three rows returned a value, and three returned null.
- The same probe ran on the changed source. The issue shape returned `**one:** a; **two:** b; Evidence: **1:** c; **2:** d`.
- The probe also replayed six hostile shapes from `origin/main`. All six kept their null result.

## Alternatives

1. **Bar the shape in the prompt and repair it.** Not taken. The fold keeps the report that the worker already wrote, and the repair turn has a content-match guard.
2. **Fold the shape with no blank lines too.** Not taken. The issue names the blank-line form, and the wider fold changes another refusal.

## Authors

Andro Marces

## Links

- [Issue #2005](https://github.com/andromarces/agent-loops/issues/2005)
- [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md)
- Implementation:
  - Fold: `foldEmptyLabelLists` in `src/lib/report.mjs`
  - Rendered rule: `reportBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/prompts/rules.test.mjs`, `tests/role/finish.abort.test.mjs`, and `tests/runtime.require-accept.test.mjs`
- [ADR Index](README.md)
