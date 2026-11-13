# 0138. Run one test command at a time in the child test-run rule

## Status

accepted

This ADR partially supersedes [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md). The superseded part is decision 6's bar list. ADR 0138 adds a bar on concurrent copies and a background test run, and names the `--if-held` form for a single-test run. Every other part of decision 6 remains in force.

## Date

2026-11-13

## Context

A Claude worker made deliberate CPU load from six concurrent copies of one test run in a single shell command (issue #1919). It also ran one copy in the background beside foreground runs and ran single tests directly. The worker said the rule did not name concurrent copies, because each copy ended inside its command.

`NO_LOAD_GENERATORS` barred a CPU or memory load generator, a busy loop, and a detached or background process that can outlive the turn. Concurrent copies that end inside one command meet none of the three terms.

## Decision

1. **One test command at a time.** `testSlotRule` adds two sentences to both command forms: "Run one test command at a time. Start no concurrent copy of a test run and no test run in the background, also when it ends inside the same command." The bar covers a copy that ends inside the command.
2. **A single-test run is a targeted run.** The form that renders a wrapper adds one sentence: "A single-test run is a targeted run and takes the --if-held wrapper form." The unquotable fallback names no `--if-held` and keeps a direct targeted run of at most 10 files.
3. **Existing bars stay.** The rule keeps its bar on a CPU or memory load generator, a busy loop, and a detached or background process that outlives the turn. It also keeps the required CI checks as the evidence under load.
4. **Docs state the rule.** `docs/orchestrator-instructions.md` states the one-command bar in one sentence. `docs/orchestrator/reviewer-evidence.md` states it on the reviewer evidence page.
5. **Both prompt paths render the rule.** The worker prompt and the reviewer prompt both render `testSlotRule`. The headless runtime and the `role` subcommand build the same prompt text, so each path carries the bar.

## Consequences

- A child cannot make deliberate load from concurrent copies of a test run.
- A single-test run takes the `--if-held` form where the rule renders a wrapper. While all slots are free, that run still starts directly.
- A `role dispatch --resume-interrupted` call resumes the stored session and renders the later-turn worker prompt, which repeats no test-run rule. Issue #1919 records this result.
- The change is prompt text and docs only. The test slot, its wait bound, and exit code 75 keep their behavior.

## Alternatives

1. **Bar only a load generator program.** Not taken. The worker judged that the three terms did not name concurrent copies of a test run.
2. **Add a separate prompt line outside `testSlotRule`.** Not taken. Both prompts already render `testSlotRule`, and the reviewer prompt carries no other slot rule.
3. **Repeat the rule on a later turn and a resumed turn.** Not taken in this change. This ADR adds the bar where both prompts already render it, and issue #1919 records the resume result.

## Authors

Andro Marces

## Links

- [Issue #1919](https://github.com/andromarces/agent-loops/issues/1919)
- Partially supersedes [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md) decision 6
- Related issues: #872, [#934](https://github.com/andromarces/agent-loops/issues/934), #1602
- Implementation:
  - Rule: `testSlotRule` in `src/prompts/rules.mjs`
  - Tests: `tests/prompts/rules.test.mjs`, `tests/role/index.test-cmd.test.mjs`, and `tests/runtime.test-cmd.test.mjs`
  - Docs: `docs/orchestrator-instructions.md` and `docs/orchestrator/reviewer-evidence.md`
- [ADR Index](README.md)
