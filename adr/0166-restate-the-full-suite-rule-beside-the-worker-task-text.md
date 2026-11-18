# 0166. Restate the full-suite rule beside the worker task text

## Status

accepted

## Date

2026-11-18

## Context

A Claude Code worker ran `npm test` directly in its work tree, outside the `test-slot` wrapper (issue #2002). It reported the bypass only in its own `Notes` line.

The worker prompt carried the full-suite rule inside the long `testSlotRule` list. A task text that named a suite command sat after that list, so the two rules were far apart.

The runtime has no signal for a test run outside the slot. A run outside the slot can overlap another run's suite and defeat the machine-wide slot limit.

## Decision

1. **One short line sits beside the task text.** `fullSuiteRule` in `src/prompts/rules.mjs` renders a two-sentence line. The first worker turn puts it immediately before `Instructions:`. A later turn puts it immediately after the task text.
2. **The line names the wrapper as the only form.** It names `npm test`, `pnpm test`, and `vp test run` as examples. It states that a full suite runs only through the test slot wrapper, or not at all.
3. **The line covers a named command from another source.** It states that the bar holds when the task, a repository doc, or a script names the suite command.
4. **An unquotable path bars a full suite.** When `slotCommandForms` returns null, the line states that no full suite runs in this turn and names the required CI checks.
5. **The existing rule text stays.** Every sentence of `testSlotRule` and the reviewer prompt stays byte-identical.

## Acceptance checks

1. The first worker turn renders the wrapper line immediately before `Instructions:`.
2. A later worker turn renders the wrapper line immediately after the task text.
3. The no-wrapper form renders the line that bars a full suite and names the CI checks.
4. Every sentence of the new line holds at most 25 words under both command forms.

## Consequences

- A worker reads the full-suite bar beside the task command that it is about to run.
- A later turn carries the bar without the full preamble.
- The change is prompt text, a reference page, and this ADR. It adds no runtime field.

## Alternatives

1. **Add a runtime advisory field.** Not taken in this change. Issue #2002 names this as the other direction, and the parent chose the clearer rule.
2. **Put the line in the rule list only.** Not taken. The issue names the distance between the list and the task text.
3. **Render the line on the first turn only.** Not taken. A later turn also receives task text that can name a suite command.

## Authors

Andro Marces

## Links

- [Issue #2002: Worker turn can run a full test suite outside the test-slot wrapper](https://github.com/andromarces/agent-loops/issues/2002)
- [PR #2003: Restate the full-suite rule beside the worker task text](https://github.com/andromarces/agent-loops/pull/2003)
- [ADR 0040: Run the test command in a test slot](0040-run-the-test-command-in-a-test-slot.md)
- [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- [Implementation: prompt rules](../src/prompts/rules.mjs)
- [Implementation: worker prompt](../src/prompts/worker.mjs)
- [ADR Index](README.md)
