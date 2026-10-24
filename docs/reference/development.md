# Maintenance

## Development

```bash
pnpm fmt         # Format files with vp fmt (Oxfmt)
pnpm fmt:check   # Check formatting
pnpm lint        # Lint files with vp lint (Oxlint)
pnpm test        # Run the test suite with vp test (Vitest)
```

The toolchain config lives in `vite.config.mjs`. A `vite-plus` upgrade re-pins the
`vite` and `vitest` overrides in `pnpm-workspace.yaml` to the values that `vite-plus`
depends on, then runs `pnpm install`. `tests/pnpm-workspace.overrides.test.mjs` fails when an override differs ([ADR 0022](https://github.com/andromarces/agent-loops/blob/main/adr/0022-vite-plus-toolchain-and-npm-distribution.md)).

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
