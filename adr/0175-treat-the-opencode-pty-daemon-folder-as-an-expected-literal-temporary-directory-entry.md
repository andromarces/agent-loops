# 0175. Treat the OpenCode pty daemon folder as an expected literal temporary directory entry

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0108: Report a literal system temporary directory entry in the inherited temporary directory field](0108-report-a-literal-system-temporary-directory-entry-in-the-inherited-tmpdir-field.md). It replaces decision 5's rule that the parent names every literal entry to the user with the exception of one known tool entry: a `literal-tmp/opencode-pty-<uid>` name on a turn whose CLI is OpenCode adds no `notes` item and no `open` item. The consequence that a macOS turn which writes directly in `/tmp` leaves a name for the parent and the user to act on holds for every other name. Decisions 1 to 4 and the rest of decision 5 stay in force.

## Date

2026-11-27

## Context

Each OpenCode worker turn on macOS reported `inheritedTmpdirEntries: ["literal-tmp/opencode-pty-<uid>"]`. The folder is the runtime folder of the OpenCode pty daemon. The worker prompt does not create it, and an observed folder was empty after the run. The parent read the entry as a forbidden literal `/tmp` write and recorded it under `notes` on every OpenCode run.

Issue #2040 offers two options: classify the known folder in the runtime, or keep the field and name the known folder in the orchestrator advisory-field rules. The operator chose the documentation branch. The runtime keeps reporting the entry, so a real worker write to the literal `/tmp` is still reported.

## Decision

1. **Keep the runtime unchanged.** `inheritedTmpdirEntries` still names `literal-tmp/opencode-pty-<uid>`, and no envelope field is added.
2. **Expect the known folder on an OpenCode turn.** A `literal-tmp/opencode-pty-<uid>` name on a turn whose CLI is OpenCode is the runtime folder of the OpenCode pty daemon, an expected tool entry. The parent adds no `notes` item and no `open` item for it.
3. **Keep every other name actionable.** Any other unattributed name with the `literal-tmp/` prefix, on an OpenCode turn or another CLI, still goes under `notes`, by name, and never under `open`. Every other unattributed entry still goes nowhere in the finish summary.
4. **State the rule on every parent surface.** The interactive instructions, the runtime advisory fields, the headless orchestrator prompt, and the child dispatch reference state the same exception.

## Consequences

- An OpenCode worker turn whose only literal `/tmp` entry is the pty daemon folder gives the parent no finish item.
- A real worker write to the literal `/tmp` is still reported under `notes`.
- The parent cannot tell the known folder from a worker folder of the same name, so a turn that reports the folder as its own leftover stays actionable under the existing leftover rule.
- The rule is advisory. The runtime reports the entry on every CLI, and the parent applies the CLI condition.

## Alternatives

1. **Classify the folder in the runtime.** Not taken. The runtime would stop reporting a name that a worker can also create, and the operator chose to keep a real worker write visible.
2. **Ignore the folder on every CLI.** Not taken. On another CLI the folder is not an expected entry, so the existing `notes` rule stays.
3. **Keep the `notes` item on OpenCode turns.** Not taken. The entry names no write of the turn and repeats on every run, which hides a real finding.

## Authors

Andro Marces

## Links

- [Issue #2040: Classify the OpenCode pty folder in literal /tmp entries of worker turns](https://github.com/andromarces/agent-loops/issues/2040)
- [ADR 0108: Report a literal system temporary directory entry in the inherited temporary directory field](0108-report-a-literal-system-temporary-directory-entry-in-the-inherited-tmpdir-field.md)
- [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md)
- [ADR 0162: Run every OpenCode call of a turn on a private server](0162-run-every-opencode-call-of-a-turn-on-a-private-server.md)
- Implementation:
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/runtime-advisory-fields.md`, `docs/reference/role.md`
  - Prompt: `src/prompts/orchestrator.mjs`
  - Tests: `tests/docs/orchestrator-instructions.test.mjs`
- [ADR Index](README.md)
