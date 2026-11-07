# 0096. Wait for a held slot in a bounded red run and report a miss

## Status

accepted

This ADR supersedes no earlier decision. It extends [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md) decision 4 and keeps every other decision of ADR 0044 and of [ADR 0046: Default the test slot count to one](0046-default-the-test-slot-count-to-one.md) in force.

## Date

2026-11-08

## Context

Issue #1612 records two of four concurrent workers that skipped or reordered their TDD red run, the failing run of the new test before the fix, while another run held the one default slot (ADR 0046). One worker never ran the red run. The other waited 10 minutes for the slot, implemented the fix first, then restored the old source from `HEAD` for one run. Neither report recorded the gap, so the reviewer had to build its own negative controls.

A red run is a targeted run of one or a few test files, so it goes through `agent-loop test-slot --if-held` (ADR 0044). With any slot held, the wrapper waits for a slot, with a default bound of 1800 s. That bound can outlive the worker turn. The issue offered three options: a bounded wait and then a direct targeted run, a shorter slot wait for a targeted run, or a worker-preamble rule to wait and report. This ADR takes the third option, because it is the smallest one that meets the three acceptance criteria: it changes the preamble only, and the wrapper, its default slot count, and its wait bound stay as they are.

## Decision

1. **A red run is a targeted run.** The worker runs a red run of one or a few test files through the test slot wrapper with `--if-held`, as ADR 0044 decision 4 tells every targeted run. It runs at once while all slots are free and waits for a slot while any slot is held. The worker implements no fix before the red run.
2. **The wait is bounded inside the turn.** The worker passes the `--wait` flag with a value below the shell tool bound of its harness, so a held slot ends the wait before the turn ends. No wrapper default changes: the change adds no flag, no shorter targeted-run wait, and no direct run after a bound.
3. **A red run that did not start is reported.** When the wrapper does not start the red run, for example with exit code 75 at the wait bound, the worker reports the red run in `Checks` as not run, with the reason, and names it in `Blockers`. A skipped red run is then visible to the parent and the reviewer.
4. **No re-ordering.** The worker never implements the fix first and restores the old source to stand in for the red run.
5. **Prompt only.** The rule is `redRunRule` in `src/prompts/rules.mjs`, used by the first-turn worker preamble in `src/prompts/worker.mjs`. The reviewer prompt carries no red-run rule, and the runtime detects no red run and no missing one. The slot count, the slot directory, the nested marker, and the exit 75 meaning are unchanged.

## Consequences

- A held slot no longer makes a red run vanish from the record: the turn names the miss in `Checks`, inside the wait bound.
- A red run behind a full suite can still exit 75 near the end of that suite and be reported as not run. The rule trades a possible miss for a bounded wait and an explicit report.
- The worker chooses the `--wait` value from the bound of its harness, so a harness with a bound other than the 10-minute Claude Code bound sets its own. No value is fixed in the prompt.
- The rule is advisory, as every prompt rule is. The runtime adds no red-run field and refuses no finish for a missing red run.
- A red run that starts while all slots are free still holds no slot (ADR 0044 decision 5), so a slot holder can start beside it.

## Alternatives

1. **A bounded wait, then a direct targeted run (issue option 1).** Not taken. It needs new wrapper behavior that runs a command outside the slot after the bound, which re-opens the untracked-load result that ADR 0044 decision 1 and the Windows measurement record.
2. **A shorter slot wait for a targeted run (issue option 2).** Not taken. A wrapper default would apply to every targeted run, and the issue needs a bound only for the red run. The existing `--wait` flag already gives the worker that bound with no code change.
3. **Report only, with the default 1800 s wait.** Not taken. The default can outlive the turn, and the turn then carries no report, which is the observed failure.

## Authors

Andro Marces

## Links

- [Issue #1612](https://github.com/andromarces/agent-loops/issues/1612)
- [PR #1622](https://github.com/andromarces/agent-loops/pull/1622)
- [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md)
- [ADR 0046: Default the test slot count to one](0046-default-the-test-slot-count-to-one.md)
- Related issues: #848, #921, #934
- Implementation:
  - Source: `redRunRule` in `src/prompts/rules.mjs`, `src/prompts/worker.mjs`
  - Tests: `tests/prompts/worker.test.mjs`, `tests/prompts/report.test.mjs`
  - Docs: `docs/reference/role.md`
- [ADR Index](README.md)
