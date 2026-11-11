# 0124. Drop Node 22 support before its end of life

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md). The replaced parts are decision 11's `engines.node` range and every Node 22 consequence. Decision 11 now states `^24.11.0 || >=26.0.0`, and the Node 22 consequences are withdrawn. Every other decision and consequence of ADR 0022 stays in force.

## Date

2026-11-11

## Context

Node 22 reaches end of life on 2027-04-30 (issue #1812). ADR 0022 set `engines.node` to `^22.18.0 || ^24.11.0 || >=26.0.0` and kept the Node 22 line in CI. The main `ci` matrix, the macOS and Windows shards, the smoke jobs, and the `node-22-floor` job ran Node 22. That job tested the `22.18.0` floor.

Node 24 is the lowest supported line after this change, and `release.yml` publishes on Node 24. The `node-24` job ran the latest Node 24 and duplicated the Ubuntu `ci` leg.

## Decision

1. **Range.** `engines.node` is `^24.11.0 || >=26.0.0` (decision 11 of ADR 0022).
2. **CI line.** The `ci` matrix, `macos-tests`, `macos-smoke`, `windows-tests`, and `windows-smoke` run Node 24.
3. **Floor job.** The `node-22-floor` job is deleted. The `node-24` job tests the `24.11.0` floor and keeps its name.
4. **Install probe.** The minimum-version probe runs `24.11.0` in place of `22.18.0`.
5. **Contexts.** The required contexts `ci (ubuntu-latest)`, `ci (macos-latest)`, and `ci (windows-latest)` keep their names.

## Consequences

- Node 22 and every version below 24.11.0 lose support. npm warns on an install outside the range, and fails with `engine-strict`.
- No CI job runs Node 22.
- The `node-24` job no longer duplicates the Ubuntu `ci` leg, because it pins the floor.
- `vp staged` needs Node 24.11.0 or later, and Git 2.32.0 or later.
- Node 27 is not tested. It ships on 2027-04-22, and issue #1812 keeps that job for a later change.

## Alternatives

1. **Keep Node 22 until its end of life.** Not taken. The change lands before 2027-04-30, so no CI job runs an unsupported line.
2. **Run the whole matrix on Node 26.** Not taken. Node 24 is the lowest supported line, so the matrix keeps one low line and the `node-26` job covers the Active LTS line.
3. **Keep the `node-22-floor` job on Node 24.11.0.** Not taken. The job name and comment name Node 22, and the `node-24` job takes the floor role.

## Authors

Andro Marces

## Links

- [Issue #1812](https://github.com/andromarces/agent-loops/issues/1812)
- [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md)
- [CI workflow](../.github/workflows/ci.yml)
- [Install probe workflow](../.github/workflows/install-probe.yml)
- [Release workflow](../.github/workflows/release.yml)
- [Package manifest](../package.json)
- [Installation](../docs/reference/install.md)
- [ADR Index](README.md)
