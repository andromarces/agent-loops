# 0173. Forbid a probe copy from linking a work tree directory

## Status

accepted

## Date

2026-11-27

## Context

A batch run on Windows made temporary `git archive` copies of earlier commits under the system temporary directory and joined each copy to the run work tree's `node_modules` with a directory junction (issue #2028). A recursive delete of such a copy can follow the junction and remove the `node_modules` that the parent installed for every turn of the run.

The worker prompt told a probe copy to link the work tree's `node_modules` (issue #1026), because a tool such as `vp` installs into the shared package store when it finds no usable `node_modules` (issue #1145). That guidance created the link that the delete could follow.

[Issue #998](https://github.com/andromarces/agent-loops/issues/998) already records the link-safe removal of a work tree folder: `rmdir /s /q` on Windows and `rm -rf` on POSIX follow no junction or symbolic link.

## Decision

1. **The worker probe-copy rule bars the link.** A probe copy of another commit installs its own dependencies, or the probe runs inside the work tree. A probe copy can be a `git worktree add` under the turn temporary directory.
2. **The rule names the failure mode.** It states that a recursive delete of the copy that follows the link removes the work tree's `node_modules`.
3. **The pnpm dependency-check clause stays.** A probe copy that runs `pnpm run` or `pnpm exec` still sets `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` or calls the installed binary directly, as issue #1145 states.
4. **The reviewer probe-copy rule stays unchanged.** This change covers the worker path that issue #2028 names.

## Acceptance checks

1. The first worker turn states the new probe-copy rule.
2. The first worker turn states no instruction to link the work tree's `node_modules` into a copy.
3. The first worker turn keeps the pnpm dependency-check clause.

## Consequences

- A worker that probes old source installs the copy's dependencies or runs the probe inside the work tree, so no link from the copy reaches the work tree's `node_modules`.
- The rule is advisory prompt text. The runtime detects no link and no recursive delete.
- An install in the copy can write the shared package store, which issue #1026 limits.
- The reviewer prompt still tells its probe copy to link the work tree's dependency directory.

## Alternatives

1. **State only the link-safe removal.** Not taken. The issue asks for the prohibition first, and the safe removal stays in issue #998 for a folder that already holds links.
2. **Enforce the prohibition in the runtime.** Not taken. The worker runs its own shell commands, and the runtime sees no link that a command creates under a temporary path.
3. **Change the reviewer rule too.** Not taken. Issue #2028 names the worker prompt, and the reviewer rule has its own acceptance in issue #1026.

## Links

- [Issue #2028: Forbid a worker probe copy from linking into the work tree node_modules](https://github.com/andromarces/agent-loops/issues/2028)
- [Issue #1026: Keep dependency installs and package-store writes out of reviewer turns](https://github.com/andromarces/agent-loops/issues/1026)
- [Issue #1145: Stop the pnpm dependency check from installing during a reviewer turn](https://github.com/andromarces/agent-loops/issues/1145)
- [Issue #998: Document a link-safe removal of the run work tree after git worktree remove](https://github.com/andromarces/agent-loops/issues/998)
- `src/prompts/rules.mjs`
- `tests/prompts/worker.test.mjs`
