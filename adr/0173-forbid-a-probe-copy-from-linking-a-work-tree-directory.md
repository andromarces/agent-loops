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

1. **A probe copy is a Git work tree.** The rule states that a probe copy of another commit is a Git work tree made with `git worktree add` under the turn temporary directory, not a `git archive` extraction.
2. **The worker probe-copy rule keeps the install bar.** A probe copy with no dependencies of its own runs only commands that need none, and the origin/main sentence `Run no dependency install, repair, or update there.` stays. The rule therefore does not contradict the worker rule against an install in another checkout.
3. **The rule bars the link.** It states that a directory of any work tree or checkout (the run work tree, the primary checkout, or another work tree) is never linked or junctioned into the probe copy.
4. **The rule removes the probe work tree first.** `git worktree remove --force` removes the probe work tree before any folder delete.
5. **The rule states the link-safe removal.** A probe copy that holds a link or junction is removed without a recursive delete that follows links: `cmd.exe /c rmdir /s /q` with a backslash path in cmd.exe or PowerShell, the `MSYS_NO_PATHCONV=1` Git Bash form with `cygpath -w`, or `rm -rf` on POSIX, in line with issue #998.
6. **The pnpm dependency-check clause stays.** A probe copy that runs `pnpm run` or `pnpm exec` still sets `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn` or calls the installed binary directly, as issue #1145 states.
7. **The reviewer probe-copy rule stays unchanged.** This change covers the worker path that issue #2028 names.

## Acceptance checks

1. The first worker turn states that a probe copy is a `git worktree add` Git work tree, not an archive extraction.
2. The first worker turn states that a probe copy with no dependencies runs only commands that need none, and keeps the origin/main ban on an install, repair, or update there.
3. The first worker turn states no instruction to link or junction a directory of any work tree or checkout into a probe copy.
4. The first worker turn removes the probe work tree with `git worktree remove --force` before any folder delete.
5. The first worker turn states the link-safe removal for a probe copy that holds a link or junction.
6. The first worker turn keeps the pnpm dependency-check clause.

## Consequences

- A worker that probes old source uses a `git worktree add` probe work tree, runs no dependency install, repair, or update there, and removes the probe work tree before any folder delete.
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
