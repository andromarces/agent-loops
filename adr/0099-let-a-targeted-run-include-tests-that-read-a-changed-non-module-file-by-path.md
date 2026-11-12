# 0099. Let a targeted run include tests that read a changed non-module file by path

## Status

accepted

## Supersedes

Partially supersedes [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md), decision 7. The superseded part is decision 7's scope: the mirror test files, the test files that import a changed source file directly, and the test files of its direct importers. This ADR keeps those three tiers and adds a fourth tier, the test files that name the path or file name of a changed file that is not an importable module. ADR 0044's 10-file bound, decision 7's order of the first three tiers, and every other decision of ADR 0044 remain in force.

## Date

2026-11-08

## Context

ADR 0044 decision 7 picked a targeted run by import edge: the mirror test files, then the test files that import a changed source file directly, then the test files of its direct importers. A test that reads a changed file as text has no import edge. It can read a shell script, a config file, or a template by path, cut a block out of it, or count its blocks. The rule left such a test out, so the worker's targeted run passed and only CI found the failure.

Issue #1611 observed the failure in an interactive `agent-loop role` run on macOS. The first worker turn removed two blocks from a bash deploy script. It ran a targeted run of 8 test files whose names match the script, and all 138 tests passed. CI failed in a Python test that reads the script by path and counts its remote blocks (`AssertionError: 1 != 2`). The test file's name does not mention the script, and it imports no module that the change touched. The failure cost one CI cycle, one worker turn to fix it, and a second CI cycle.

The change is material. A test that reads a changed non-module file now qualifies for an idle `--if-held` targeted run, where before it needed the plain wrapper or the required CI checks. It replaces part of ADR 0044 decision 7, so it is a new ADR rather than an in-place amendment.

## Decision

1. **Fourth tier inside the bound.** A targeted run covers the test files that mirror the changed source files first, then the test files that import a changed source file directly, then the test files of the direct importers of a changed source file, then the test files that name the path or file name of a changed file that is not an importable module, for example a script, a config file, or a template, at most 10 test files in total, never a whole directory. The first three tiers keep their order and the 10-file bound of ADR 0044 decision 3 stays.
2. **Tracked-file content search.** A worker or reviewer finds the fourth tier with a tracked-file content search, for example `git grep -l <file name> -- <test globs>`. The search reads tracked files only. An untracked or generated test file is out of scope.
3. **Prompts and docs.** `TARGETED_RUN_BOUND` in `src/prompts/rules.mjs` states the order in both `testSlotRule` forms, so every worker and reviewer prompt carries it. `docs/reference/test-slot.md`, `docs/orchestrator/reviewer-evidence.md`, and `adr/README.md` restate it.
4. **Unchanged.** A broader run is a full suite and goes only through the plain test slot wrapper, or the required CI checks stand in for it. Exit code 75 stays unresolved. A run whose paths cannot be quoted keeps a direct targeted run of at most 10 files, and a broader run relies on the required CI checks.

## Consequences

- A worker or reviewer targeted run now includes the text reader of a changed non-module file before CI sees it.
- A test in the fourth tier spends one of the 10 file slots, so a broad file name can fill the bound. The first three tiers keep their order and a whole directory never runs.
- ADR 0044 decision 7 is partially superseded. Its other decisions and the earlier tiers of decision 7 stay in force.
- Limit: the tier needs a tracked test file that names the path or file name. A dynamic path that constructs the name with no literal file name, an untracked test, or a generated test can still escape. A broader run or CI covers that case.
- Limit: the content search can name a test that only mentions the file in a comment or a fixture. A false positive costs one file slot and no correctness.

## Alternatives

1. **Amend ADR 0044 decision 7 in place.** Not taken. The tier is material: a test that was excluded from an idle targeted run now qualifies. AGENTS requires a new ADR that partially supersedes the replaced decision.
2. **Keep the plain wrapper or CI for text readers.** Not taken. It repeats the observed CI failure and the extra worker and CI cycles.
3. **Search every tracked file without a test glob or run a directory.** Not taken. The 10-file bound and the no-directory rule stay.
4. **Add an import-like edge for text reads.** Not taken. It needs a parser or a build step for scripts, config files, and templates, and the content search finds the test files with no new infrastructure.

## Authors

Andro Marces

## Links

- [Issue #1611](https://github.com/andromarces/agent-loops/issues/1611)
- [PR #1619](https://github.com/andromarces/agent-loops/pull/1619)
- [ADR 0044: Route a targeted run through the test slot while any slot is held](0044-route-a-targeted-run-through-the-test-slot-while-a-slot-is-held.md) (decision 7 superseded)
- Related issues: [#1078](https://github.com/andromarces/agent-loops/issues/1078), [#1492](https://github.com/andromarces/agent-loops/issues/1492)
- Implementation:
  - Source: `TARGETED_RUN_BOUND` and `testSlotRule` in `src/prompts/rules.mjs`
  - Tests: `tests/prompts/rules.test.mjs`
  - Docs: `docs/reference/test-slot.md`, `docs/orchestrator/reviewer-evidence.md`, `adr/README.md`
- [ADR Index](README.md)
