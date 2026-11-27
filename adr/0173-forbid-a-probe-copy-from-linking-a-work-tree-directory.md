# 0173. Forbid a probe copy from linking a work tree directory

## Status

accepted

## Date

2026-11-27

## Context

A batch run on Windows made temporary `git archive` copies of earlier commits under the system temporary directory and joined each copy to the run work tree's `node_modules` with a directory junction (issue #2028). The worker reported that it removed the copies and that `node_modules` stayed intact. A recursive delete of such a copy can follow the junction and remove the `node_modules` that the parent installed for every turn of the run.

The worker prompt told a probe copy to link the work tree's `node_modules` (issue #1026), because a tool such as `vp` installs into the shared package store when it finds no usable `node_modules` (issue #1145). That guidance created the link that the delete could follow.

[Issue #998](https://github.com/andromarces/agent-loops/issues/998) already records the link-safe removal of a work tree folder: `rmdir /s /q` on Windows and `rm -rf` on POSIX follow no junction or symbolic link.

## Decision

1. **The worker probe-copy rule keeps the install bar.** A probe of old source runs inside the work tree instead, or uses a copy under the turn temporary directory, for example a `git worktree add` checkout, with no link or junction to a work tree directory. The copy installs no dependencies, so the rule does not contradict the worker rule against an install in another checkout.
2. **The rule names the failure mode.** It states that a recursive delete of the copy that follows the link can remove the work tree's `node_modules`.
3. **The rule states the link-safe removal.** A copy that holds a link or junction is removed without a recursive delete that follows links: `rmdir /s /q` on Windows and `rm -rf` on POSIX, in line with issue #998.
4. **The pnpm dependency-check clause stays.** A probe copy that runs `pnpm run` or `pnpm exec` still sets `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` or calls the installed binary directly, as issue #1145 states.
5. **The reviewer probe-copy rule stays unchanged.** This change covers the worker path that issue #2028 names.

## Acceptance checks

1. The first worker turn states the new probe-copy rule.
2. The first worker turn states no instruction to link the work tree's `node_modules` into a copy, and no instruction to install in the copy.
3. The first worker turn states the link-safe removal for a copy that holds a link or junction.
4. The first worker turn keeps the pnpm dependency-check clause.

## Consequences

- A worker that probes old source runs the probe inside the work tree, or uses an unlinked copy that installs no dependencies.
- A probe copy that holds a link or junction is removed without a recursive delete that follows links.
- The rule is advisory prompt text. The runtime detects no link and no recursive delete.
- The reviewer prompt still tells its probe copy to link the work tree's dependency directory.

## Alternatives

1. **State only the prohibition.** Not taken. A copy can already hold a link or a junction into the shared store, and issue #2028 requires the safe removal for that case.
2. **Let the copy install its own dependencies.** Not taken. The worker prompt bars an install in another checkout, and a copy under a temporary directory is another checkout.
3. **Enforce the prohibition in the runtime.** Not taken. The worker runs its own shell commands, and the runtime sees no link that a command creates under a temporary path.
4. **Change the reviewer rule too.** Not taken. Issue #2028 names the worker prompt, and the reviewer rule has its own acceptance in issue #1026.

## Links

- [Issue #2028: Forbid a worker probe copy from linking into the work tree node_modules](https://github.com/andromarces/agent-loops/issues/2028)
- [Issue #1026: Keep dependency installs and package-store writes out of reviewer turns](https://github.com/andromarces/agent-loops/issues/1026)
- [Issue #1145: Stop the pnpm dependency check from installing during a reviewer turn](https://github.com/andromarces/agent-loops/issues/1145)
- [Issue #998: Document a link-safe removal of the run work tree after git worktree remove](https://github.com/andromarces/agent-loops/issues/998)
- [PR #2032: Forbid a worker probe copy from linking into the work tree node_modules](https://github.com/andromarces/agent-loops/pull/2032)
- `src/prompts/rules.mjs`
- `tests/prompts/worker.test.mjs`
