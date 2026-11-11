# 0128. Publish on Node 26 with a pnpm trust policy

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md). The replaced part is decision 13's Node 24 publish line. `npm stage publish` now runs on Node 26, and every other part of decision 13 stays in force.

## Date

2026-11-12

## Context

`pnpm-workspace.yaml` held only `virtualStoreType` and `overrides`. pnpm turns `trustPolicy` off by default, so an install accepts a package version with less trust than an earlier one.

The publish job in `.github/workflows/release.yml` ran Node 24. Node 24 is in Maintenance LTS since 2026-10-20. Node 26 is the Active LTS line, and Node 26.13.0 bundles npm 11.20.0, which meets the npm 11.15.0 gate (issue #1839).

## Decision

1. **Trust policy.** `pnpm-workspace.yaml` sets `trustPolicy: no-downgrade`. pnpm 12.18.0 accepts the key, and a frozen-lockfile install passes.
2. **Publish line.** The publish job in `release.yml` runs `node-version: 26`. The npm version gate step stays unchanged.
3. **Comment.** The comment above `setup-node` names Node 26.13.0 and its bundled npm 11.20.0.

## Consequences

- A package version with less trust than an earlier version fails the install.
- A frozen-lockfile install verifies the lockfile against the supply-chain policy. The check passed with 169 entries.
- A Node 26 runner with a cached older 26.x still fails the npm version gate when its npm is below 11.15.0.
- Node 24 stays a supported line for the package, and the CI matrix keeps its Node 24 jobs.

## Alternatives

1. **Leave `trustPolicy` off.** Not taken. The default accepts a trust downgrade.
2. **Publish on Node 24.** Not taken. Node 24 is in Maintenance LTS, and Node 26.13.0 bundles npm 11.20.0.

## Authors

Andro Marces

## Links

- [Issue #1839](https://github.com/andromarces/agent-loops/issues/1839)
- [PR #1879](https://github.com/andromarces/agent-loops/pull/1879)
- [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md)
- [Workspace settings](../pnpm-workspace.yaml)
- [Release workflow](../.github/workflows/release.yml)
- [ADR Index](README.md)
