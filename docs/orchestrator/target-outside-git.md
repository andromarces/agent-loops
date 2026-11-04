# A target outside any Git repository

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when the task names a file in a directory that is not a Git work tree and must never become one. Read it again before the copy-back after `finish`.

`role dispatch` refuses such a `--cwd` with `--cwd must be inside a Git work tree: <path>`. Use a throwaway repository in a scratch path outside the user workspace. Copy the target file into it at the same relative path, then make the first commit.

Record the content hash of the original target before the import:

```bash
git hash-object "<target>"
```

This hash is the content of the imported commit. Create the run work tree from the local default branch, as [Work tree setup details](work-tree-setup.md) states for a repository with no remote.

Run the loop on that work tree. The run is not PR work, because no pull request can exist. Finish it with a plain `role finish` and no PR gate. Do this after a reviewer `verdict: accept` with a `Checks` line on the latest changed state, as that file states.

The copy-back is the delivery step of this run, like the merge or hand-off of a no-remote run. It runs after `finish`, when the run is terminal. The parent is allowed to run this step, and the [role rule](../orchestrator-instructions.md#role) names it as the exception. Copy the accepted file from the work tree at `reviewed.head` over the original target.

Record the content hash of the original target again right before the copy:

```bash
git hash-object "<target>"
```

Compare it with the hash from before the import. A difference means that the original changed during the run, so stop and report to the user. A missing target is a difference too. On a difference, copy nothing.

A headless run cannot run the copy-back. `finish` ends that loop, and every orchestrator turn is read-only. The operator delivers the accepted file there.

Remove the work tree after the copy, as [Removing a work tree](work-tree-removal.md) states. Then remove the throwaway repository. Never remove the work tree before the copy.
