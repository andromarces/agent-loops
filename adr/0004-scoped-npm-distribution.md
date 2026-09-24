# 0004. Distribute the CLI as a scoped public npm package

## Status

accepted

## Date

2026-09-24

## Context

The only install path was `git clone` plus `pnpm install`, then `node <clone>/src/cli.mjs` from the target repository. The `agent-loop` binary in `package.json` reached `PATH` only inside the clone, so a user had to know the absolute clone path. The README promises a run on Windows, macOS, and Linux from any workspace.

The unscoped name `agent-loops` is taken on npm by an unrelated package, so the project needs a scoped name. The package has one runtime dependency (`execa`); `husky` is a devDependency wired through a `prepare` script that a consumer install must not require.

## Decision

Publish the CLI to the public npm registry as `@andromarces/agent-loops`, with `publishConfig.access: public` for the scoped name.

1. Keep runtime dependencies in `dependencies` and keep the `bin` entries in `package.json`; a registry install needs neither `pnpm` nor any devDependency. Expose the CLI as both `agent-loop` and `agent-loops`: with several bins, `npx` and `pnpm dlx` resolve the executable only when a bin name matches the unscoped package name.
2. Replace `"prepare": "husky"` with `"prepare": "node .husky/install.mjs"`. The guard exits 0 when Husky is absent, so a registry or Git-URL install succeeds on Windows cmd, PowerShell, macOS, and Linux.
3. Mark the `bin` scripts executable in git and keep the `#!/usr/bin/env node` shebang, so POSIX installs link an executable file and npm generates the Windows `.cmd` and `.ps1` shims. Detect the process entry point by comparing real paths, so a bin reached through a symlinked package directory (pnpm, npm on POSIX) runs the CLI instead of exiting with no output.
4. Publish from a GitHub Actions release workflow on a published GitHub release or a manual dispatch, with `--provenance` and the `id-token: write` permission, on Node 24 so the bundled npm CLI supports trusted publishing. A release event must have a tag that matches the `package.json` version. The workflow authenticates with OIDC trusted publishing and stores no npm token. npm requires the package to exist before a trusted publisher can be configured, so the first version is published once from a developer checkout; later releases use the workflow.
5. Keep `--cwd` as the way to target another work tree; the default stays the current directory, so the installed command works from any directory.

## Consequences

- A user installs once (`npm install -g @andromarces/agent-loops`, `pnpm add -g`, `npx`, or `pnpm dlx`) and runs `agent-loop` from any directory on all three platforms.
- The published package ships `docs/orchestrator-instructions.md`, and the `agent-loop-copilot` launcher resolves it relative to the installed file, so the launcher works outside a clone. The parent-edit guard stays repo-local and fail-open.
- Releases are repeatable and carry a provenance attestation that links the tarball to this repository and commit.
- The `prepare` guard does not make Git-URL installs lightweight: npm still installs devDependencies before `prepare` runs.
- Standalone binaries (Node SEA, `pkg`) and OS package managers (Homebrew, Scoop, winget) stay out of scope until the npm package is stable.

## Alternatives

1. **Unscoped `agent-loops`**: The name is already taken by an unrelated package.
2. **`pnpm link --global` only**: Requires a clone and a global bin directory on `PATH`; it does not meet the any-directory goal.
3. **Publish on a `push` to `main`**: Publishes unreviewed commits and duplicates CI validation; a release event gates on a reviewed tag.
4. **Standalone binaries**: Node 22+ is already required, so a registry package is sufficient; binaries add a build matrix for no current gain.

## Authors

Andro Marces

## Links

- [Issue #1: Make agent-loop installable globally and runnable from any directory](https://github.com/andromarces/agent-loops/issues/1)
- [Pull Request #109: feat: publish the CLI as a scoped npm package](https://github.com/andromarces/agent-loops/pull/109)
- [Pull Request #110: feat: authenticate the release workflow with OIDC trusted publishing](https://github.com/andromarces/agent-loops/pull/110)
- [Implementation: package manifest](../package.json)
- [Implementation: prepare guard](../.husky/install.mjs)
- [Implementation: entry-point detection](../src/lib/entrypoint.mjs)
- [Implementation: release workflow](../.github/workflows/release.yml)
- [npm trusted publishing with OIDC](https://docs.npmjs.com/trusted-publishers)
- [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements)
- [ADR Index](README.md)
