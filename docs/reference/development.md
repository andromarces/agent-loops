# Maintenance

## Development

```bash
pnpm fmt         # Format files with vp fmt (Oxfmt)
pnpm fmt:check   # Check formatting
pnpm lint        # Lint files with vp lint (Oxlint)
pnpm test        # Run the test suite with vp test (Vitest)
pnpm test:duration  # Print total time and the 20 slowest files and tests
```

`pnpm test:duration` runs the suite and prints the total wall time. It lists the 20 slowest test files and the 20 slowest tests with durations. A total time per operating system more than 10% over the base branch needs a PR justification. Compare only runs with the same runner class, test configuration, worker count, and sharding configuration.

The toolchain config lives in `vite.config.mjs`. A `vite-plus` upgrade re-pins the
`vite` and `vitest` overrides in `pnpm-workspace.yaml` to the values that `vite-plus`
depends on, then runs `pnpm install`. `tests/pnpm-workspace.overrides.test.mjs` fails when an override differs ([ADR 0022](https://github.com/andromarces/agent-loops/blob/main/adr/0022-vite-plus-toolchain-and-npm-distribution.md)).

### From a clone (development)

Development uses pnpm and the repository Git hooks. The dev toolchain is
Vite+ (`vite-plus`), which needs the Node range in [Requirements](install.md#requirements).
The `pre-commit` hook runs `vp staged`, which needs Node 22.22.1 or later on the
22 line, or 24.11.0 or later, and Git 2.32.0 or later. Every script runs the
project-local `vp`, so no global `vp` install is needed. User-scope integrations
point at the package location, so a clone registers its own copy with `npm link`
before `agent-loop install`:

```bash
git clone <repository-url>
cd agent-loops
pnpm install
npm link
agent-loop install
```

`npm link` writes its bin shim to the global prefix bin directory, so that
directory must be on `PATH` for `agent-loop` to resolve. It is the
`npm prefix -g` directory on Windows and `$(npm prefix -g)/bin` on macOS and
Linux.

Entries rendered from a clone point at that clone. After the clone moves, run
`npm link --force` from the new location, then `agent-loop install` again. A
plain `npm link` fails with `EEXIST` on Windows when a shim already exists.
`--force` overwrites the shim.
`pnpm link` is not a supported path: pnpm 12 `link` has no global mode. Without a
link, call the CLI entry directly and quote the repository path so a path with
spaces works:

```bash
node "<repo>/src/cli.mjs" install --harness claude --yes
```

`pnpm agent-loop` still runs the CLI entry from the repository root. The
repository Git hooks run formatting and linting on commit and push. They need
`pnpm install` to have completed, because its `prepare` script installs the
Vite+ hook dispatcher (`vp config`). The hook scripts live in `.vite-hooks/`.

`prepare` exits 0 in CI, in production, with `VP_GIT_HOOKS=0`, and when
`vite-plus` is absent. `prepare` writes nothing to stdout. When the dispatcher
install fails, it writes one warning line to stderr and still exits 0. A clone set up under Husky has a local `core.hooksPath`
that resolves to `<repo>/.husky/_`. `prepare` unsets only that local value, so
`vp config` can install the dispatcher. Any other hooks path, and a value in the
global or system config, stays unchanged.

## Releasing

The release workflow stages a version on a published GitHub release or a manual dispatch, authenticated by OIDC trusted publishing. No npm token is stored.

npm requires the package to exist before a trusted publisher can be configured, so the first version is published once from a checkout:

```bash
npm login
npm publish
```

Then add a trusted publisher on npmjs.com: package settings, **Trusted publishing**, **GitHub Actions**, organization or user `andromarces`, repository `agent-loops`, workflow filename `release.yml`, allowed actions `npm stage publish`.

For later releases, bump the version, then publish a GitHub release with tag `v<version>`. The tag must match the `package.json` version. The workflow runs `npm stage publish` and prints a stage id. Review and approve the staged version with 2FA:

```bash
npm stage list
npm stage view <stage-id>
npm stage approve <stage-id>
```

A manual dispatch must run on the release tag, for example `gh workflow run release.yml --ref v<version>`. A dispatch on a branch is rejected, because npm records provenance from the run ref, not the checked-out commit.

The version goes live only after approval. Staged publishing needs npm 11.15.0 or later and 2FA on the account.

## Manual smoke test

Run against real CLI agents in a temporary Git repository.

Bash:

```bash
mkdir /tmp/smoke-repo && cd /tmp/smoke-repo &&
git init &&
git -c user.name=smoke -c user.email=smoke@example.invalid commit --allow-empty -m "init" &&
agent-loop \
  --orchestrator codex \
  --worker claude \
  --reviewer agy \
  --max-steps 4 \
  --timeout 600 \
  --transcript ./run.json \
  --task "Add a README line that names the project."
```

PowerShell:

```powershell
& {
  $ErrorActionPreference = "Stop"
  $smokeRepo = Join-Path $env:TEMP "smoke-repo"
  New-Item -ItemType Directory $smokeRepo | Out-Null
  Set-Location $smokeRepo
  git init
  if ($LASTEXITCODE -ne 0) { throw "git init failed" }
  git -c user.name=smoke -c user.email=smoke@example.invalid commit --allow-empty -m "init"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
  agent-loop `
    --orchestrator codex `
    --worker claude `
    --reviewer agy `
    --max-steps 4 `
    --timeout 600 `
    --transcript ./run.json `
    --task "Add a README line that names the project."
}
```

Both blocks stop at the first failed step, so `agent-loop` never runs in an unintended directory. An existing `smoke-repo` directory is a failure: remove it before a rerun. In PowerShell, a backtick must be the last character on its line, with no trailing space.
