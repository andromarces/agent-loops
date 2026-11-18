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

1. **Fold one second dash list after one blank line.** A single extra `- ` run joins the label value with `; ` after exactly one blank line. A third run, two blank lines, an ordered second run, a repeated label, and a label-reading prose line still refuse.
2. **Fold a plain prose line and its dash list across one blank line.** Exactly one blank line must precede the prose line, and its `- ` items must follow after one blank line. The pair joins the label above as `<prose>: <items>`, and the fold consumes both blanks. A whole-line bold heading keeps its rule: its list must sit directly under it.
3. **Apply the fold once.** The shared parse in `src/lib/report.mjs` serves the dispatch envelope, interactive `role finish --require-accept`, and headless `runLoop` with `requireAccept` true.
4. **Keep every other rejection.** A decorated label and a list after the reviewer `Verdict:` line stay unparseable. A prose line with a label name, a two-blank-line gap, and an ordered list under a prose line also stay unparseable.
5. **State the rule in the prompt and the docs.** `reportBlock` in `src/prompts/rules.mjs` and `docs/orchestrator/closing-block.md` state both new folds.

## Consequences

- The issue #2005 shape parses, and every item of both dash lists and the prose line stays in the value.
- The replay row with no blank lines before the prose stays null, because the prose fold needs the blank line above.
- A third dash run, a two-blank-line gap, and a prose lead with no blank line above keep their `origin/main` refusal.
- The dispatch envelope, the interactive gate, and the headless gate read the same report, because all three use the shared parse.
- A repair turn no longer treats the second dash list as a defect that needs no content change.

### Probe

- The probe ran `parseReportBlock` from source `ffaf28d0` on the six issue shapes. Three rows returned a value, and three returned null.
- The same probe ran on the changed source. The issue shape returned `**one:** a; **two:** b; Evidence: **1:** c; **2:** d`.
- Three head shapes differ from `ffaf28d0`. They are a second run after a direct first run, a second run after a blank-line first run, and the issue shape. The ADR records all three.
- The three review shapes keep their null result at `ffaf28d0` and on this head. They are a third run, two blanks before a prose lead, and a prose lead with no blank line above.

## Alternatives

1. **Bar the shape in the prompt and repair it.** Not taken. The fold keeps the report that the worker already wrote, and the repair turn has a content-match guard.
2. **Fold the shape with no blank lines too.** Not taken. The issue names the blank-line form, and the wider fold changes another refusal.

## Authors

Andro Marces

## Links

- [Issue #2005](https://github.com/andromarces/agent-loops/issues/2005)
- [PR #2007: Fold a second dash list and a prose line under one label](https://github.com/andromarces/agent-loops/pull/2007)
- [ADR 0140: Fold every closing-block list level](0140-fold-every-closing-block-list-level.md)
- Implementation:
  - Fold: `foldEmptyLabelLists` in `src/lib/report.mjs`
  - Rendered rule: `reportBlock` in `src/prompts/rules.mjs`
  - Docs: `docs/orchestrator/closing-block.md`
  - Tests: `tests/lib/report.test.mjs`, `tests/prompts/rules.test.mjs`, `tests/role/finish.abort.test.mjs`, and `tests/runtime.require-accept.test.mjs`
- [ADR Index](README.md)
