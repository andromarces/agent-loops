# 0123. Shard the macOS CI test job behind a fan-in required context

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0079: Shard the Windows CI test job behind a fan-in required context](0079-shard-the-windows-ci-test-job.md). The replaced part is decision 1's `ci` matrix `[ubuntu-latest, macos-latest]`. The matrix now holds `ubuntu-latest` only, and macOS work moves to the shard, smoke, and gate jobs below. Decision 1's format and lint rule stays in force on the Linux leg. Every other decision of ADR 0079 stays in force. That includes `fail-fast: false`, the concurrency group, the `pull_request` and `workflow_dispatch` triggers, the absent pnpm cache, and the unchanged Windows jobs.

## Date

2026-11-11

## Context

`ci (macos-latest)` was the longest pull request job. On 2026-11-09 its median was 274 s over 11 successful runs (issue #1767). That measurement included fixed sleeps in `tests/batch/supervisor.test.mjs`. Issue #1763 replaced those sleeps with event waits, and PR #1795 merged that change on 2026-11-10.

Thirteen successful `pull_request` runs from 2026-11-10T19:14Z to 2026-11-10T20:02Z contain that merge. The macOS job median is 230 s, with a range of 207 s to 249 s. Its test step median is 208 s, with a range of 190 s to 223 s. The slowest Windows shard, `windows-tests (2)`, has a median of 161 s and a range of 131 s to 187 s. `ci (ubuntu-latest)` has a median of 114 s.

macOS stays longer than every Windows shard, so the rule of issue #1767 calls for sharding. Branch protection requires the contexts `ci (ubuntu-latest)`, `ci (windows-latest)`, and `ci (macos-latest)`. The issue asks for no ruleset edit.

## Decision

1. **Matrix.** The `ci` matrix holds `[ubuntu-latest]`. Its context keeps the name `ci (ubuntu-latest)` and its steps, including `fmt:check` and `lint` on the Linux leg.
2. **Test shards.** A `macos-tests` job runs on `macos-latest` with `shard: [1, 2]` and runs `pnpm exec vp test run --shard=<i>/2`. The runner lists `--shard <shards>` as `<index>/<count>`.
3. **Direct call.** The step calls the runner directly. A `--` separator in `pnpm test -- --shard=<i>/2` makes vp drop the shard argument, so every shard runs the full suite.
4. **Smoke.** A `macos-smoke` job runs the unchanged install/uninstall probe once, unsharded.
5. **Gate.** A `macos-gate` job is named `ci (macos-latest)`. It needs both macOS jobs, runs `if: always()` on `ubuntu-latest`, and exits non-zero unless both results are `success`.
6. **Scope.** Sharding covers the test step only. No test is deleted, skipped, weakened, or moved off macOS, and no timeout changes.
7. **Standard runners.** Every new job uses a standard hosted runner.

## Consequences

- macOS wall time is the slowest shard plus setup, with the smoke job in parallel. Two shards put the expected value below 150 s, against 230 s observed.
- The required context now reports the aggregate. A failed or cancelled shard or smoke job fails it. A gate job that never runs leaves the context absent, which main protection already treats as unmet.
- macOS test failures are attributed to one shard job instead of one job.
- Each shard and the smoke job repeat checkout, pnpm setup, Node setup, and install. That setup is parallel and costs no wall time when the runner pool is free.
- Two shard jobs plus the smoke job consume three standard `macos-latest` runners per run. They are free for a public repository.
- A single merged test report is not produced. No report or coverage gate exists, so no blob merge is needed.

## Alternatives

1. **Keep one macOS job.** Not taken. Its median of 230 s stays above the slowest Windows shard median of 161 s.
2. **Shard into three or more jobs.** Not taken. Two shards already match the slowest Windows shard, and each extra shard repeats the full setup.
3. **Move the install/uninstall probe into a shard.** Not taken. A probe failure then fails a shard and hides the test result.
4. **Edit the ruleset to require the new shard names.** Not taken. The issue forbids the edit, and it couples merge gating to the shard count.

## Authors

Andro Marces

## Links

- [Issue #1767](https://github.com/andromarces/agent-loops/issues/1767)
- [PR #1809](https://github.com/andromarces/agent-loops/pull/1809)
- [ADR 0079: Shard the Windows CI test job behind a fan-in required context](0079-shard-the-windows-ci-test-job.md)
- [CI workflow](../.github/workflows/ci.yml)
- [ADR Index](README.md)
