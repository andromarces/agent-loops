# 0148. Omit dead rules from the headless orchestrator prompt

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0074: Report the side that changed in localFilesDiffer](0074-report-the-side-that-changed-in-local-files-differ.md) and [ADR 0078: Record a hand refresh of a copied local file](0078-record-a-hand-refresh-of-a-copied-local-file.md). The replaced part of each is decision 5's statement that the headless prompt tells its parent the `localFilesDiffer` actions. The interactive documentation statement in both decisions stays in force, and every other decision of both ADRs stays in force.

## Date

2026-11-15

## Context

The headless orchestrator prompt in `src/prompts/orchestrator.mjs` stated two blocks of rules that a headless run cannot act on. The first block named the `localFilesDiffer` actions for `source`, `copy`, and `both`. The second block named the refused `--cwd` rules, including its own statement that a headless run cannot act on a refused `--cwd`.

`localFilesDiffer` is added only to a later `role dispatch` envelope. `withLocalFiles` in `src/role/dispatch.mjs` adds the field on a non-init dispatch. The headless runtime in `src/runtime.mjs` calls `runChild` directly and never adds or forwards the field, so a headless result cannot carry it.

A refused `--cwd` ends a headless run before its first orchestrator turn. `src/cli.mjs` runs `assertGitWorkTree` on the run `--cwd` before it calls `runLoop`, and the runtime snapshot ends a run whose `--cwd` changes during a turn. The headless orchestrator therefore receives no refused `--cwd` it could repair, abort, or report.

The rules stay in force for the interactive parent. `docs/orchestrator-instructions.md` states the refused `--cwd` rule, and `docs/orchestrator/local-files-copy.md` states the `localFilesDiffer` actions. A `role dispatch` parent still receives the field and still acts on it.

## Decision

1. **State only live rules.** A headless orchestrator prompt states only the rules that a headless run can receive input for and act on. It omits a rule for an envelope field that only `role dispatch` adds, and a rule for an input path that ends the headless run before its first turn.
2. **Omit the localFilesDiffer rules.** The headless prompt omits the field shape, the `source` action, the `copy` action, and the `both` action. A headless result cannot carry `localFilesDiffer`.
3. **Omit the refused --cwd rules.** The headless prompt omits the repair refusal, the abort condition, the one-rule message, and the headless snapshot statement. Those rules stay in the Work tree ownership section of `docs/orchestrator-instructions.md`.
4. **Keep the rules in force where they act.** The interactive instructions and `docs/orchestrator/local-files-copy.md` keep both rule sets. `src/role/dispatch.mjs` keeps adding `localFilesDiffer` to a later dispatch envelope, and the `role` parent keeps the refresh and breach actions that ADR 0074 and ADR 0078 state.
5. **Keep the live source-window rule.** The headless prompt keeps `localSourceChangedInTurn`, because `runChild` in `src/child-turn.mjs` adds that field to a headless result. A later field that a headless result carries needs its own prompt rule, and this decision adds no general parity bar.

## Consequences

- The headless prompt spends no budget on an action the run cannot take.
- The interactive parent keeps every action that ADR 0074 and ADR 0078 state.
- The runtime field and its `role dispatch` behavior do not change.
- The prompt tests pin the omission, and the doc tests pin the rules in the interactive text.
- A future field that reaches a headless result adds a prompt rule on its own evidence, not by restoring an old parity rule.

## Alternatives

1. **Keep the rules in both prompts.** Rejected. The headless prompt then states actions that no headless result can trigger, and the two ADRs read as if the field reached both paths.
2. **Remove the rules from the interactive text too.** Rejected. A `role dispatch` parent receives `localFilesDiffer` and needs the source, copy, and both actions.
3. **Add the field to a headless result.** Rejected. The headless run calls `runChild` directly and compares no copied source with a dispatch hash, so the field has no value there.

## Authors

Andro Marces

## Links

- [Issue #1938: Trim role text, fix read-condition drift, and drop headless-only prompt rules](https://github.com/andromarces/agent-loops/issues/1938)
- [Pull request #1953](https://github.com/andromarces/agent-loops/pull/1953)
- [ADR 0074: Report the side that changed in localFilesDiffer](0074-report-the-side-that-changed-in-local-files-differ.md)
- [ADR 0078: Record a hand refresh of a copied local file](0078-record-a-hand-refresh-of-a-copied-local-file.md)
- [ADR 0002: Harness-neutral orchestrator instructions with thin entry points](0002-harness-neutral-orchestrator-instructions.md)
- Implementation: the headless prompt in `src/prompts/orchestrator.mjs`, `runChild` direct dispatch in `src/runtime.mjs`, `withLocalFiles` in `src/role/dispatch.mjs`, and `assertGitWorkTree` before `runLoop` in `src/cli.mjs`
- Documented in the [orchestrator instructions](../docs/orchestrator-instructions.md) and [Local files copied into the work tree](../docs/orchestrator/local-files-copy.md)
- Tests: `tests/prompts/orchestrator.test.mjs` and `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
