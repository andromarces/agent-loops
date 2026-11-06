# 0079. Shard the Windows CI test job behind a fan-in required context

## Status

accepted

## Date

2026-11-06

## Context

`ci (windows-latest)` carried all Windows work in one job: install, `pnpm test`, and the install/uninstall probe. It was the long pole on every pull request. In five successful `pull_request` runs on 2026-11-06 the Windows job took 572, 594, 536, 527, and 316 s, and the `pnpm test` step took 525, 547, 485, 485, and 280 s. The medians were about 2.3x the macOS test step and 4.9x the Ubuntu test step.

Branch protection requires the contexts `ci (ubuntu-latest)`, `ci (windows-latest)`, and `ci (macos-latest)`. A job matrix entry produces one context per OS, so moving test work into new jobs would break the required context unless the names are preserved or the ruleset is edited. The issue asks for no ruleset edit.

## Decision

1. The `ci` matrix keeps `[ubuntu-latest, macos-latest]`, so its two contexts keep their names and steps. Format and lint stay on the Linux leg.
2. A `windows-tests` job runs on `windows-latest` with `shard: [1, 2, 3, 4]` and runs `pnpm exec vp test run --shard=<i>/4`. The runner supports the flag: `vp test --help` lists `--shard <shards>` as `<index>/<count>`. The step calls the runner directly because `pnpm test -- --shard=<i>/4` inserts a `--` separator on the script command, and vp drops the arguments after it, so every shard would run the full suite.
3. A `windows-smoke` job runs on `windows-latest` and runs the unchanged install/uninstall probe once, unsharded.
4. A `windows-gate` job is named `ci (windows-latest)`, needs both Windows jobs, runs `if: always()` on `ubuntu-latest`, and exits non-zero unless both `needs` results are `success`. The required context becomes the aggregate, so `main-protection` needs no edit.
5. All jobs keep `fail-fast: false`, the existing workflow-level concurrency group, the existing `pull_request` and `workflow_dispatch` triggers, and no `setup-node` pnpm cache.
6. Sharding covers the test step only. No test is deleted, skipped, weakened, or moved off Windows, and no timeout is changed.

## Consequences

- Windows wall time is the slowest shard plus its setup, with the smoke job in parallel. The expected value is about a quarter of the single-job test time plus setup, near 200 s against 527 to 594 s observed. Per-file cost is uneven, so the split is not guaranteed to balance and stays to be measured.
- The required context now reports the aggregate. A failed or cancelled shard or smoke job fails it. A gate job that never runs leaves the context absent, which main protection already treats as unmet.
- Windows test failures are attributed to one shard job instead of one job, so a failing shard is narrower to read.
- Each shard and the smoke job repeat checkout, pnpm setup, Node setup, and install. That setup is parallel and costs no wall time when the runner pool is free.
- Four shard jobs plus the smoke job consume five standard `windows-latest` runners per run. They are free for a public repository.
- A single merged test report is not produced. No report or coverage gate exists, so no blob merge is needed.

## Alternatives

1. Shard all three operating systems. Not taken. Linux and macOS are not the long pole and already finish near 100 and 200 s.
2. Drop the Windows install/uninstall probe to save wall time. Not taken. It is the only Windows installer evidence before merge.
3. Edit the ruleset to require the new shard job names. Not taken. The issue forbids the edit and it would couple merge gating to the shard count.
4. Shard by directory. Not taken. Per-filesystem locality is not the bottleneck and file count per directory is uneven.
5. Use two or three shards. Not taken. Two shards measured 331 s of wall time, above the 300 s target; three shards exceeded the 1.5x slowest-to-fastest target in three of five runs. Four shards cut the per-shard work while leaving the wall target margin.
6. Merge per-shard blob reports. Not taken. Nothing consumes a merged report today.

## Authors

Andro Marces

## Links

- [Issue #1552](https://github.com/andromarces/agent-loops/issues/1552)
- [PR #1555](https://github.com/andromarces/agent-loops/pull/1555)
- [CI workflow](../.github/workflows/ci.yml)
- [ADR Index](README.md)
