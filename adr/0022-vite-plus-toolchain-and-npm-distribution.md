# 0022. Run the dev toolchain and Git hooks through Vite+

## Status

accepted

Supersedes [ADR 0004: Distribute the CLI as a scoped public npm package](0004-scoped-npm-distribution.md). The decisions of ADR 0004 that still hold are restated below, with two changes: the `prepare` guard installs the Vite+ hook dispatcher in place of Husky, and `engines.node` follows the `vite-plus` Node range.

## Date

2026-10-06

## Context

Formatting, linting, tests, and the staged-file hook used five separate
devDependencies: `oxfmt`, `oxlint`, `vitest`, `lint-staged`, and `husky`, each with
its own config. Vite+ (`vite-plus`, `vp` CLI) 1.0.0 is stable. It wraps Oxfmt,
Oxlint, Vitest, and lint-staged behind one CLI and one config file, and ships a Git
hook dispatcher (`vp config`) (issue #500). The published package runtime uses none
of them.

ADR 0004 wired Husky through a `prepare` guard that a consumer install must not
require. Removing Husky changes that decision materially, so this ADR supersedes
ADR 0004 and restates its live decisions.

`vite-plus@1.0.0` pins `oxfmt` `=0.70.0`, `oxlint` `=1.85.0`, and `vitest` `5.0.1`,
older than the versions the lockfile resolved (0.71.0, 1.86.0, 5.0.3). It declares
Node `^22.18.0 || ^24.11.0 || >=26.0.0`.

## Decision

### Toolchain

1. Add `vite-plus@1.0.0` as the one toolchain devDependency. Remove `oxfmt`,
   `oxlint`, `vitest`, `lint-staged`, and `husky`.
2. Replace `vitest.config.mjs` and `.oxfmtrc.json` with `vite.config.mjs`. It holds
   the `test` block, empty `fmt` and `lint` blocks (tool defaults, as before), and a
   `staged` block. Test files import from `vite-plus/test`.
3. Scripts call the project-local `vp`: `vp fmt`, `vp fmt --check`, `vp lint`,
   `vp test run`, `vp test watch`. No global `vp` install is required.
4. `pnpm-workspace.yaml` overrides `vite` to `npm:@voidzero-dev/vite-plus-core@1.0.0`
   and `vitest` to `5.0.1`, so test files and the `vp test` runner share one Vitest
   copy. Each `vite-plus` upgrade re-pins `vitest` to the version that
   `vp --version` lists.
5. Keep separate steps. `vp check` is not adopted, because it also lints. The
   `pre-commit` hook runs `vp staged`, whose rule formats staged JS/TS files only.
   The `pre-push` hook runs `vp fmt --check` repo-wide and `vp lint` over the JS/TS
   files of the pushed range.
6. CI keeps its shape (`pull_request` trigger, concurrency group, three-OS matrix,
   `pnpm/action-setup`, no pnpm cache per #38, install retry) and runs the same three
   scripts. `voidzero-dev/setup-vp` is not adopted.
7. Oxfmt, Oxlint, and Vitest update only with a `vite-plus` release.

### Git hooks and the `prepare` guard

8. The Vite+ hook dispatcher manages the hooks. Project hook scripts live in
   `.vite-hooks/` and are committed. `vp config` generates the dispatcher in
   `.vite-hooks/_/`, which is ignored, and points `core.hooksPath` at it.
9. `"prepare": "node .vite-hooks/install.mjs"`. The guard exits 0 in CI
   (`CI=true`), in production (`NODE_ENV=production`), with `VP_GIT_HOOKS=0`, and
   when `vite-plus` is absent, so a registry or Git URL install never requires it.
   Otherwise it runs `vp config --no-agent` with the current Node binary. `--no-agent`
   keeps `vp config` away from `AGENTS.md` and `CLAUDE.md`. `vp config` skips the
   install when `core.hooksPath` points elsewhere, so the guard first unsets a
   `core.hooksPath` of `.husky/_` left by a Husky clone.

### Distribution (restated from ADR 0004)

10. Publish the CLI to the public npm registry as `@andromarces/agent-loops`, with
    `publishConfig.access: public`. Keep runtime dependencies in `dependencies` and
    the `bin` entries in `package.json`; a registry install needs neither `pnpm` nor
    any devDependency. Expose the CLI as both `agent-loop` and `agent-loops`, so
    `npx` and `pnpm dlx` resolve the executable.
11. `engines.node` is `^22.18.0 || ^24.11.0 || >=26.0.0`, the `vite-plus@1.0.0`
    range. The ADR 0004 floor was `>=22`.
12. Mark the `bin` scripts executable in git and keep the `#!/usr/bin/env node`
    shebang. Detect the process entry point by comparing real paths, so a bin
    reached through a symlinked package directory runs the CLI.
13. Stage releases from a GitHub Actions workflow on a published GitHub release or a
    manual dispatch, on the tag `v<version>`, with `--provenance`, OIDC trusted
    publishing, no stored npm token, and `npm stage publish` on Node 24. A
    maintainer approves each staged version with 2FA.
14. Keep `--cwd` as the way to target another work tree; the default stays the
    current directory.

## Consequences

- One config file and one devDependency replace five devDependencies and two config
  files. The packed file list does not change.
- The tool versions go back to the ones Vite+ pins. On this change, the repo-wide
  format check passes under both `oxfmt` 0.71.0 and 0.70.0 on the same file set.
  `oxlint` 1.86.0 and 1.85.0 both report 0 warnings and 0 errors on 122 files with
  96 rules. A warning still does not fail the run. The Vitest 5.0.2 and 5.0.3 fixes
  cover features this suite does not use (browser mode, jsdom, UI, `repeats`,
  `test.fails`, `expect.extend`).
- A `vite-plus` upgrade must re-pin the `vitest` override by hand. Dependabot does
  not do it: dependabot-core (`main` at `47c1f006b3db`, 2026-10-05) reads only
  `catalog` and `catalogs` from `pnpm-workspace.yaml`, not `overrides`.
- `pnpm install` reports an unmet `vite` peer of `vitest`, because the alias
  resolves to `@voidzero-dev/vite-plus-core@1.0.0`. The install, the frozen-lockfile
  install, and the test suite pass.
- Node 22.0 to 22.17 and 24.0 to 24.10 lose support. npm warns on an install
  outside the range, and fails with `engine-strict`.
- `vp staged` needs Node 22.22.1 or later on the 22 line, or 24.11.0 or later, and
  Git 2.32.0 or later.
- The dispatcher runs each hook script with `sh -e` and puts `node_modules/.bin` on
  `PATH`. Git for Windows runs it through its `sh`.
- A clone set up under Husky migrates on its next `pnpm install`. Work trees share
  `core.hooksPath`, so a work tree still on a Husky commit runs no hooks after
  another work tree of the same clone migrates.
- `VP_GIT_HOOKS=0` and `HUSKY=0` make every installed hook exit 0.
- The `prepare` guard does not make a Git URL install lightweight: npm still
  installs devDependencies before `prepare` runs.

## Alternatives

1. **Keep Husky beside Vite+**: rejected. Vite+ ships a dispatcher with the same
   hook model, and one tool fewer removes a devDependency.
2. **`"prepare": "vp config"` without a guard**: rejected. It fails when `vite-plus`
   is absent and runs in CI, and without `--no-agent` it can rewrite the instruction
   files.
3. **`vp check` as one gate**: rejected. It lints in `pre-commit`, which changes the
   format-only contract.
4. **Keep `engines.node` at `>=22`**: rejected. A Git URL install pulls
   `vite-plus`, and the published range then promises Node versions the dev
   toolchain does not support.
5. **`voidzero-dev/setup-vp` in CI**: rejected. `pnpm/action-setup` and the local
   `vp` cover it, and the #38 no-cache rule stays simple.
6. **Amend ADR 0004 in place**: rejected. The ADR rules require a new ADR for a
   material change.

## Authors

Andro Marces

## Links

- Supersedes [ADR 0004: Distribute the CLI as a scoped public npm package](0004-scoped-npm-distribution.md)
- [Issue #500](https://github.com/andromarces/agent-loops/issues/500)
- [Pull Request #501](https://github.com/andromarces/agent-loops/pull/501)
- [Implementation: toolchain config](../vite.config.mjs)
- [Implementation: prepare guard](../.vite-hooks/install.mjs)
- [Implementation: hook scripts](../.vite-hooks/)
- [Implementation: package manifest](../package.json)
- [Implementation: overrides](../pnpm-workspace.yaml)
- [Implementation: release workflow](../.github/workflows/release.yml)
- [Vite+ commit hooks guide](https://viteplus.dev/guide/commit-hooks)
- [Vite+ migration guide](https://viteplus.dev/guide/migrate)
- [ADR Index](README.md)
