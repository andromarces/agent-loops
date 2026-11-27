# 0174. Forbid a reviewer probe copy from linking into the work tree

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0173: Forbid a probe copy from linking a work tree directory](0173-forbid-a-probe-copy-from-linking-a-work-tree-directory.md). It replaces decision 2's install-ban sentence, which becomes `Run no dependency install, repair, or update in any probe copy.`, decision 7, which kept the reviewer probe-copy rule unchanged, the consequence that the reviewer prompt links the work tree's dependency directory, and alternative 4, which declined to change the reviewer rule. Decisions 1, 3, 4, 5, and 6 and every other consequence of ADR 0173 remain in force.

## Date

2026-11-27

## Context

The worker and reviewer prompts share the probe-copy rule in `src/prompts/rules.mjs`. PR #2032 (#2028) made the worker variant a `git worktree add` probe work tree with no link or junction, and ADR 0173 decision 7 left the reviewer variant, `probeCopyRule("repository")`, unchanged. The reviewer rule still told a probe copy to link the dependency directory of the work tree with a junction on Windows or a symlink elsewhere. A recursive delete of such a copy can follow the link and remove the dependencies of the work tree, the risk that #2028 fixed for the worker.

The worker form does not carry over to the reviewer. `git worktree add` writes to the shared worktree registry under `.git`, and the reviewer turn forbids a change of Git state. The reviewer rule keeps the plain copy method that main states, which writes nothing to the repository, and adds only the link ban and the link-safe removal that issue #2034 asks for.

The review of PR #2032 also noted that the worker install ban read `Run no dependency install, repair, or update there.`, where `there` pointed at a probe copy with no dependencies of its own. The wording left a copy of the same commit outside the ban. Issue #2034 names both changes.

## Decision

1. **The reviewer keeps the plain copy method of main.** A reviewer probe copy is a plain copy, as main states with `A probe copy of the repository, for example a copy of old source`, and it uses no `git worktree add`. That command writes to the shared worktree registry of the repository, which the reviewer read-only Git contract forbids.
2. **The reviewer link ban covers every probe copy.** A copy of the current commit and a copy of another commit never link or junction a directory of any work tree or checkout (the work tree, the primary checkout, or another work tree) into it.
3. **The reviewer rule keeps the install ban.** The reader gets no dependency install, repair, or update in this turn and starts no command that installs. In a probe copy, the rule calls the installed binary directly instead of a package manager run or exec command, or reports the probe as unresolved in Checks.
4. **The reviewer rule states the link-safe removal.** A probe copy that holds a link or junction is removed without a recursive delete that follows links, in the ADR 0173 wording.
5. **The worker rule keeps the ADR 0173 form.** The worker probe copy stays a `git worktree add` work tree with no link or junction, a probe copy with no dependencies of its own runs only commands that need none, and `git worktree remove --force` removes the probe work tree before any folder delete.
6. **The worker install ban names any probe copy.** The sentence becomes `Run no dependency install, repair, or update in any probe copy.`, so it covers a copy of the same commit as well as a copy of another commit.
7. **The shared clauses appear once.** The install ban and the link-safe removal are shared constants. The Git work tree sentence and the work tree removal stay in the worker variant, because the reviewer copy is a plain copy.
8. **The reviewer prompt names no tool or directory.** The reviewer still fits any repository (ADR 0038), so its rule names no package manager, runner, or dependency directory.

## Acceptance checks

1. The reviewer prompt states that a probe copy of the current commit or another commit never links or junctions a directory of any work tree or checkout into it, and a test asserts the prompt text that the reviewer receives.
2. The reviewer prompt states no `git worktree add` and no `git worktree remove`, and a test asserts it.
3. The reviewer prompt states the link-safe removal, keeps the install ban, and names no tool or directory, and a test asserts it.
4. The worker prompt states the Git work tree copy, its removal, and `Run no dependency install, repair, or update in any probe copy.`, and a test asserts it.

## Consequences

- A reviewer probe of old source uses a plain copy, runs no dependency install there, and removes the copy. The copy writes no shared Git state.
- A reviewer probe copy that holds a link or junction is removed without a recursive delete that follows links.
- The rule is advisory prompt text. The runtime detects no link and no recursive delete.
- The worker prompt keeps the Git work tree form. The install ban and the link-safe removal are shared, so a later change to either clause reaches both variants.

## Alternatives

1. **Keep the reviewer link.** Not taken. A recursive delete of the copy can follow the link and remove the work tree's dependencies (issue #2028).
2. **Let the reviewer probe copy install its own dependencies.** Not taken. The reviewer install ban keeps installs out of the turn, and a copy under a temporary directory is outside the repository.
3. **Enforce the prohibition in the runtime.** Not taken. The reviewer runs its own shell commands, and the runtime sees no link that a command creates under a temporary path.

## Links

- [Issue #2034: Forbid a reviewer probe copy from linking into the work tree](https://github.com/andromarces/agent-loops/issues/2034)
- [PR #2036: Forbid a reviewer probe copy from linking into the work tree](https://github.com/andromarces/agent-loops/pull/2036)
- [ADR 0173: Forbid a probe copy from linking a work tree directory](0173-forbid-a-probe-copy-from-linking-a-work-tree-directory.md)
- [Issue #2028: Forbid a worker probe copy from linking into the work tree node_modules](https://github.com/andromarces/agent-loops/issues/2028)
- [Issue #1026: Keep dependency installs and package-store writes out of reviewer turns](https://github.com/andromarces/agent-loops/issues/1026)
- [Issue #998: Document a link-safe removal of the run work tree after git worktree remove](https://github.com/andromarces/agent-loops/issues/998)
- `src/prompts/rules.mjs`
- `tests/prompts/reviewer.test.mjs`
- `tests/prompts/worker.test.mjs`
