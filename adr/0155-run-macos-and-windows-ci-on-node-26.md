# 0155. Run the macOS and Windows CI jobs on Node 26

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0124: Drop Node 22 support before its end of life](0124-drop-node-22-support.md). The replaced part is decision 2's Node 24 line for `macos-tests`, `macos-smoke`, `windows-tests`, and `windows-smoke`: those four jobs run Node 26. Decision 2's `ci` matrix line and every other decision and consequence of ADR 0124 stay in force.

## Date

2026-11-15

## Context

Only Ubuntu ran Node 26 in CI. The `ci` leg of the matrix ran the latest Node 24, the `node-26` job covered the Active LTS line, and the `macos-tests`, `macos-smoke`, `windows-tests`, and `windows-smoke` jobs ran Node 24. Node 24 is in Maintenance LTS since 2026-10-20, `engines.node` is `^24.11.0 || >=26.0.0`, and the publish job in `.github/workflows/release.yml` runs Node 26 (issue #1946).

A macOS or Windows job on Node 24 therefore tests a line that the publish path does not use, while no macOS or Windows job tests the line that ships. Issue #1946 asked whether the two platforms move to Node 26 or gain Node 26 jobs beside Node 24, and the owner decided on 2026-11-15 that they move.

## Decision

1. **CI line.** The `macos-tests`, `macos-smoke`, `windows-tests`, and `windows-smoke` jobs run `node-version: 26`. No Node 24 job runs on macOS or Windows.
2. **Node 24 coverage.** Node 24 stays covered on Ubuntu. The `ci (ubuntu-latest)` leg keeps `node-version: 24`, and the `node-24` job keeps the `24.11.0` floor.
3. **Publish line.** The publish job in `release.yml` runs Node 26, so the macOS and Windows jobs test the line that publishes the package.
4. **Contexts.** The required contexts `ci (ubuntu-latest)`, `ci (macos-latest)`, and `ci (windows-latest)` keep their names. The fan-in jobs `macos-gate` and `windows-gate` still publish the macOS and Windows contexts.
5. **Comment.** The comment above the `node-26` job names the macOS and Windows jobs as Node 26 jobs.

## Consequences

- The macOS and Windows jobs test the Active LTS line that the package publishes from.
- Node 24 stays tested on Ubuntu only. A Node 24 defect that appears on macOS or Windows alone is no longer caught, and CI does not catch it.
- The `node-24` floor job keeps the `24.11.0` minimum supported version under test.
- The required context names and the workflow-level concurrency group stay unchanged, so main protection needs no edit.
- Every other consequence of ADR 0124 stays: Node 22 and every version below 24.11.0 lose support, and Node 27 is not tested.

## Alternatives

1. **Add Node 26 jobs beside Node 24 on macOS and Windows.** Not taken. The owner chose a move, and a second shard set doubles the slowest platform jobs on every pull request.
2. **Run the whole matrix and the floor job on Node 26.** Not taken. The floor job is the only test of 24.11.0, and `engines.node` still admits the Node 24 line.
3. **Keep Node 24 on macOS and Windows.** Not taken. Node 24 is in Maintenance LTS, and the two platforms would test no shipping line.

## Authors

Andro Marces

## Links

- [Issue #1946](https://github.com/andromarces/agent-loops/issues/1946)
- [CI workflow](../.github/workflows/ci.yml)
- [Release workflow](../.github/workflows/release.yml)
- [ADR 0124: Drop Node 22 support before its end of life](0124-drop-node-22-support.md)
- [ADR 0128: Publish on Node 26 with a pnpm trust policy](0128-publish-on-node-26-with-a-pnpm-trust-policy.md)
- [ADR Index](README.md)
