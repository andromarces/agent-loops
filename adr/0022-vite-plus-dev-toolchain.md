# 0022. Run the dev toolchain through Vite+

## Status

accepted

## Date

2026-10-06

## Context

Formatting, linting, tests, and the staged-file hook used four separate
devDependencies: `oxfmt`, `oxlint`, `vitest`, and `lint-staged`, each with its own
config. Vite+ (`vite-plus`, `vp` CLI) 1.0.0 is stable and wraps Oxfmt, Oxlint,
Vitest, and lint-staged behind one CLI and one config file (issue #500). The
published package runtime does not use any of them.

`vite-plus@1.0.0` pins `oxfmt` `=0.70.0`, `oxlint` `=1.85.0`, and `vitest` `5.0.1`,
older than the versions the lockfile resolved (0.71.0, 1.86.0, 5.0.3). It declares
Node `^22.18.0 || ^24.11.0 || >=26.0.0`.

## Decision

1. Add `vite-plus@1.0.0` as the one toolchain devDependency. Remove `oxfmt`,
   `oxlint`, `vitest`, and `lint-staged`.
2. Replace `vitest.config.mjs` and `.oxfmtrc.json` with `vite.config.mjs`. It holds
   the `test` block, empty `fmt` and `lint` blocks (tool defaults, as before), and a
   `staged` block. Test files import from `vite-plus/test`.
3. Scripts call the project-local `vp`: `vp fmt`, `vp fmt --check`, `vp lint`,
   `vp test run`, `vp test watch`. No global `vp` install is required.
4. `pnpm-workspace.yaml` overrides `vite` to `npm:@voidzero-dev/vite-plus-core@1.0.0`
   and `vitest` to `5.0.1`, so test files and the `vp test` runner share one Vitest
   copy. Each `vite-plus` upgrade re-pins `vitest` to the version that
   `vp --version` lists.
5. Keep the hook contracts and Husky. `pre-commit` runs `vp staged`, whose rule
   formats staged JS/TS files only and never lints. `pre-push` runs
   `vp fmt --check` repo-wide and `vp lint` over the pushed range. `vp check` is not
   adopted, because it also lints in `pre-commit`. ADR 0004 and its `prepare` guard
   stay unchanged.
6. Keep `engines.node` at `>=22`, the runtime floor of the published package. The
   README documents the `vite-plus` Node floor for a clone and a Git URL install.
7. CI keeps its shape (`pull_request` trigger, concurrency group, three-OS matrix,
   `pnpm/action-setup`, no pnpm cache, install retry) and runs the same three
   scripts. `voidzero-dev/setup-vp` is not adopted.

## Consequences

- One config file and one devDependency replace four of each.
- The tool versions go back to the ones Vite+ pins. On this change, the repo-wide
  format check passes under both `oxfmt` 0.71.0 and 0.70.0 on the same file set.
  `oxlint` 1.86.0 and 1.85.0 both report 0 warnings and 0 errors on 122 files with
  96 rules. A warning still does not fail the run.
- Dependabot no longer updates Oxfmt, Oxlint, or Vitest on their own. They update
  only with a `vite-plus` release, and that update must re-pin the `vitest`
  override by hand. Dependabot also can propose a bump of the `vitest` override;
  if it does, add an ignore rule so the pin stays on the bundled version.
- `pnpm install` reports an unmet `vite` peer of `vitest`, because the alias
  resolves to `@voidzero-dev/vite-plus-core@1.0.0`. The install, the frozen-lockfile
  install, and the test suite pass.
- A clone and a Git URL install need the `vite-plus` Node range. On Node 22.0 to
  22.17, npm warns, and fails only with `engine-strict`. `prepare` does not call
  `vp`, so the `vp` binary never runs during a Git URL install. A registry install
  installs no devDependencies and is not affected.
- `vp staged` needs Node 22.22.1 or later on the 22 line, or 24.11.0 or later, and
  Git 2.32.0 or later.

## Alternatives

1. **Vite+ hook dispatcher (`vp config`, `.vite-hooks`) in place of Husky**: not
   adopted in this change. Husky already runs both hooks, and ADR 0004 guards its
   `prepare`. A move needs a new guard and an ADR that supersedes ADR 0004.
2. **`vp check` as one gate**: rejected. It lints in `pre-commit`, which changes the
   format-only contract.
3. **Raise `engines.node` to the `vite-plus` range**: rejected. The published
   package runs on Node 22, and a registry install pulls no devDependencies.
4. **`voidzero-dev/setup-vp` in CI**: rejected. `pnpm/action-setup` and the local
   `vp` cover it, and the #38 no-cache rule stays simple.

## Authors

Andro Marces

## Links

- [Issue #500](https://github.com/andromarces/agent-loops/issues/500)
- Implementation: `vite.config.mjs`, `pnpm-workspace.yaml`, `package.json`,
  `.husky/pre-commit`, `.husky/pre-push`
- [Vite+ migration guide](https://viteplus.dev/guide/migrate)
- [ADR 0004](0004-scoped-npm-distribution.md)
- [ADR Index](README.md)
