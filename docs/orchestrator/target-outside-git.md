# A target outside any Git repository

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when the task names a file in a directory that is not a Git work tree and must never become one. Read it again before the copy-back after `finish`.

`role dispatch` refuses such a `--cwd` with `--cwd must be inside a Git work tree: <path>`. Use a throwaway repository in a scratch path outside the user workspace. Before the import `git add`, set `core.autocrlf=false` in it and write `* -text` to its `.git/info/attributes`. The info attributes have the highest precedence, so a `.gitattributes` in the imported content cannot re-enable line-ending conversion or normalize the imported bytes. Copy the target file into it at the same relative path, then make the first commit.

Record the content hash of the original target before the import:

```bash
git hash-object --no-filters "<target>"
```

This hash is the content of the imported commit. The info attributes keep the imported blob and the run work tree at the bytes of the original, whatever line-ending rules a `.gitattributes` states. Create the run work tree from the local default branch, as [Work tree setup details](work-tree-setup.md) states for a repository with no remote.

Run the loop on that work tree. The run is not PR work, because no pull request can exist. Finish it with a plain `role finish` and no PR gate. Do this after a reviewer `verdict: accept` with a `Checks` line on the latest changed state, as that file states.

The copy-back is the delivery step of this run, like the merge or hand-off of a no-remote run. It runs after `finish`, when the run is terminal. The parent is allowed to run this step, and the [role rule](../orchestrator-instructions.md#role) names it as the exception. Write the accepted file from the blob at `reviewed.head` over the original target. Do not copy the work tree file, because the work tree can hold line endings that the blob does not. Never write the `git show` output straight to the target: the redirect truncates the target before the command runs, so a path that the task deleted would leave an empty file. Write to a temporary file beside the target and move it over the target only after `git show` succeeds. Run this in bash, where `<path>` is the relative path of the target:

```bash
git -C "<throwaway repository>" cat-file -e "<reviewed.head>^{commit}" 2>/dev/null || {
  echo "copy-back failed: <reviewed.head> is not a commit" >&2
  exit 1
}
if git -C "<throwaway repository>" cat-file -e "<reviewed.head>:<path>" 2>/dev/null; then
  tmp="$(mktemp "<target>.XXXXXX")"
  git -C "<throwaway repository>" show "<reviewed.head>:<path>" > "$tmp" &&
    mv -f "$tmp" "<target>" || {
      rm -f "$tmp"
      exit 1
    }
else
  rm -f "<target>"
fi
```

The redirect writes the bytes unchanged, so use bash, not a PowerShell version whose `>` re-encodes the output. `mktemp` creates the temporary file beside the target, and the block removes the target only when `reviewed.head` no longer holds `<path>`, which is how a task deletes the file.

Record the content hash of the original target again right before the copy:

```bash
git hash-object --no-filters "<target>"
```

Compare it with the hash from before the import. A difference means that the original changed during the run, so stop and report to the user. A missing target is a difference too. On a difference, copy nothing.

After the copy, check the delivered state. When `reviewed.head` holds `<path>`, compare the content hash of the delivered file with the blob:

```bash
git -C "<throwaway repository>" rev-parse "<reviewed.head>:<path>"
git hash-object --no-filters "<target>"
```

The two hashes must be equal. When `reviewed.head` does not hold `<path>`, the task deleted it, and the delivery is complete only when `<target>` is absent. A remaining file, or a different hash, means that the delivered state is not the reviewed blob, so report it and do not call the delivery complete.

A headless run cannot run the copy-back. `finish` ends that loop, and every orchestrator turn is read-only. The operator delivers the accepted file there.

Remove the work tree after the copy, as [Removing a work tree](work-tree-removal.md) states. Then remove the throwaway repository. Never remove the work tree before the copy.
