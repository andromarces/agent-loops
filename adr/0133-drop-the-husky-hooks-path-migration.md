# 0133. Drop the Husky hooks-path migration from the prepare guard

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md). The replaced parts are decision 9's Husky `core.hooksPath` unset and the consequence that a clone set up under Husky migrates on its next `pnpm install`. Every other decision and consequence of ADR 0022 stays in force.

## Date

2026-11-12

## Context

The project dropped Husky in commit `206ea020` (2026-10-06, ADR 0022). `prepare` kept a migration step for a clone that still held a local `core.hooksPath` of `<repo>/.husky/_`. Only a clone made before that commit holds that value. Every other `prepare` run paid the import of `.vite-hooks/husky-path.mjs` and two Git probes for no effect (issue #1904). A broken helper also took the warning path (#1856, #1865).

## Decision

1. **No migration.** `.vite-hooks/install.mjs` imports no Husky helper and runs no Git probe. It resolves `vite-plus`, then runs `vp config --no-agent`.
2. **Deleted helper.** `.vite-hooks/husky-path.mjs` is removed.

## Consequences

- A clone that still holds the Husky `core.hooksPath` keeps it after this change. `vp config` then skips the install, so no hook runs and no warning appears. The fix is `git config --local --unset core.hooksPath`.
- Every `prepare` run in a clean clone runs one child process, `vp config --no-agent`, and no Git probe.
- The guard still exits 0 in CI, in production, with `VP_GIT_HOOKS=0`, when `vite-plus` is absent, and outside a Git work tree.
- A failed dispatcher install still writes one warning line to stderr and exits 0.
- The `core.hooksPath` case in `tests/lib/evidence/shared-git.test.mjs` stays. It reports any hooks-path change, not this migration.

## Alternatives

1. **Keep the migration.** Not taken. A clone holds that value only if it was made before Husky removal.
2. **Warn instead of unset.** Not taken. The warning adds a permanent check to every install for a one-time condition.

## Authors

Andro Marces

## Links

- [Issue #1904](https://github.com/andromarces/agent-loops/issues/1904)
- [ADR 0022: Run the dev toolchain and Git hooks through Vite+](0022-vite-plus-toolchain-and-npm-distribution.md)
- [Implementation: prepare guard](../.vite-hooks/install.mjs)
- [Implementation: install tests](../tests/vite-hooks/install.test.mjs)
- [Implementation: development guide](../docs/reference/development.md)
- [ADR Index](README.md)
