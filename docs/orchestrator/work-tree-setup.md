# Work tree setup details

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you create the work tree when the repository has no remote or the run is on an existing pull request, and when `push.default` is `matching`.

The no-upstream rule guards a plain `git push` only when `push.default` follows
the upstream. With `push.default=matching`, a plain `git push` pushes every
local branch that has a remote branch of the same name. A linked work tree
shares its local branches with the main checkout. So a local default branch that
is ahead of `origin/<default>` is pushed too.

The named push closes the gap only when the worker follows it. A worker that
runs a plain `git push` anyway can push the default branch under `matching`.
With `extensions.worktreeConfig` on, `git config --worktree push.default matching`
sets the value for one work tree only. That value overrides the repository
value. The `git config push.default` read in
[Work tree ownership](../orchestrator-instructions.md#work-tree-ownership) reads the
effective value of the work tree, override included.

A repository with no remote has no `origin/<default>`, so the creation
command in [Work tree ownership](../orchestrator-instructions.md#work-tree-ownership)
fails. Use the local default branch as the base:

```bash
git worktree add --no-track -b <branch> <work tree> <default>
```

In that repository, a worker commits in the work tree and never pushes, because
there is no remote for `git push -u origin <branch>`. After `finish`, the parent
merges the branch or hands it to the user.

That run is not PR work, because no pull request can exist. Finish it with a plain
`role finish` and no PR gate, after a reviewer `verdict: accept` with a `Checks`
line on the latest changed state. Add `--require-accept` where it applies. Compare
`reviewed.head` with the `workTree.head` of the last worker envelope. Never pass
`--pr`, `--require-ci`, or `--compare-head`, never run `declare-pr`, and never set
`unresolvedCompare`: each one concerns a PR head, and this run has none, so the
#286 gap does not apply to it.

A run on an existing pull request, such as a review or a correction of PR #N, must
run on the PR head branch. Then the worker pushes to that branch, and
`reviewed.head` can equal the PR head. Create the work tree on that branch from the
remote branch:

```bash
git fetch origin <pr branch>
git worktree add --no-track -B <pr branch> <work tree> origin/<pr branch>
```

`-B` creates the branch, or moves an existing local branch of that name to
`origin/<pr branch>`. If the local branch exists, run
`git rev-list --left-right --count <pr branch>...origin/<pr branch>` first. A left
count above 0 means the local branch is ahead of or diverged from the PR head. Then
`-B` drops its local-only commits from the branch, so do not run the command:
report to the user. A left count of 0 means the local branch equals or is behind the
PR head, and the command is safe. The command fails when another work tree has the
branch checked out. Then report to the user, and never remove that work tree.

`-B` keeps the upstream of an existing local branch. A plain `git push` of a worker
follows that upstream, so the upstream must be `origin/<pr branch>` or none, and
never the default branch. Before the first dispatch, read it with
`git -C "<work tree>" for-each-ref --format='%(upstream:short)' "refs/heads/<pr branch>"`.
If it prints another branch, such as `origin/<default>`, run
`git -C "<work tree>" branch --unset-upstream`, or set the PR branch with
`git -C "<work tree>" branch -u origin/<pr branch>`.

The upstream `origin/<pr branch>` is acceptable, because the PR branch is the branch
that the worker must push. The `--no-track` rule guards a new branch that tracks
`origin/<default>`. The worker pushes with `git push -u origin <pr branch>`.

The work tree head must equal the PR head before the first dispatch: compare
`git -C "<work tree>" rev-parse HEAD` with
`gh pr view <pr> --json headRefOid --jq .headRefOid`. If they differ, the PR head
moved after the fetch. Run `git fetch origin <pr branch>` and
`git -C "<work tree>" merge --ff-only origin/<pr branch>`, then compare again. If
the heads still differ, dispatch nothing and report to the user.
