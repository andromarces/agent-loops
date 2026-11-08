# A target outside any Git repository

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when the task names a file in a directory that is not a Git work tree and must never become one. Read it again before the copy-back after `finish`.

`role dispatch` refuses such a `--cwd` with `--cwd must be inside a Git work tree: <path>`. Use a throwaway repository in a scratch path outside the user workspace. Before the import `git add`, set `core.autocrlf=false` in it and write `* -text` to its `.git/info/attributes`. A `.gitattributes` in the imported content cannot re-enable line-ending conversion or normalize the imported bytes. Copy the target file into it at the same relative path, then make the first commit. When the target does not exist because the task adds it, make the first commit empty with `git commit --allow-empty`, so `<import commit>` records the absence.

When the target exists, record its content hash before the import. When it does not exist, record that it is absent and leave `ORIGINAL` empty at the copy-back:

```bash
git hash-object --no-filters -- "<target>"
```

For an existing target, this hash is the content of the imported commit. After the first commit, record the import commit:

```bash
git -C "<throwaway repository>" rev-parse HEAD
```

Call it `<import commit>`. Create the run work tree from the local default branch, as [Work tree setup details](work-tree-setup.md) states for a repository with no remote.

Run the loop on that work tree. The run is not PR work. Finish it with a plain `role finish` and no PR gate. Do this after a reviewer `verdict: accept` with a `Checks` line on the latest changed state, as that file states.

The copy-back is the delivery step of this run. It runs after `finish`, when the run is terminal. The parent is allowed to run this step, and the [role rule](../orchestrator-instructions.md#role) names it as the exception. Write the accepted file from the blob at `reviewed.head` over the original target. Do not copy the work tree file. Never write the `git show` output straight to the target. Run this in bash, where `<path>` is the relative path of the target:

```bash
REPO="<throwaway repository>"
IMPORT="<import commit>"
REVIEWED="<reviewed.head>"
FILE="<path>"
TARGET="<target>"
ORIGINAL="<original hash>"

case "$TARGET" in
  /* | [A-Za-z]:* | \\* | ./* | ../*) ;;
  *) TARGET="./$TARGET" ;;
esac
CREATED=""
cleanup_dirs() {
  while IFS= read -r d; do
    [ -n "$d" ] && rmdir -- "$d" 2>/dev/null
  done <<< "$CREATED"
  CREATED=""
}

git -C "$REPO" cat-file -e "$IMPORT^{commit}" 2>/dev/null &&
  git -C "$REPO" cat-file -e "$REVIEWED^{commit}" 2>/dev/null || {
    echo "copy-back failed: a commit is not readable" >&2
    exit 1
  }
DELETED=$(git -C "$REPO" -c core.quotePath=false diff --name-only --diff-filter=D "$IMPORT" "$REVIEWED" -- "$FILE") || {
  echo "copy-back failed: the reviewed diff is not readable" >&2
  exit 1
}
ADDED=$(git -C "$REPO" -c core.quotePath=false diff --name-only --diff-filter=A "$IMPORT" "$REVIEWED" -- "$FILE") || {
  echo "copy-back failed: the reviewed diff is not readable" >&2
  exit 1
}
[ -z "$DELETED" ] || [ "$DELETED" = "$FILE" ] || {
  echo "copy-back failed: <path> matches more than one file" >&2
  exit 1
}
[ -z "$ADDED" ] || [ "$ADDED" = "$FILE" ] || {
  echo "copy-back failed: <path> matches more than one file" >&2
  exit 1
}

if [ -n "$DELETED" ]; then
  [ -n "$ORIGINAL" ] && [ "$(git hash-object --no-filters -- "$TARGET" 2>/dev/null)" = "$ORIGINAL" ] || {
    echo "copy-back failed: the original changed" >&2
    exit 1
  }
  rm -f -- "$TARGET"
elif git -C "$REPO" cat-file -e "$REVIEWED:$FILE" 2>/dev/null; then
  if [ "$ADDED" = "$FILE" ]; then
    [ ! -e "$TARGET" ] || {
      echo "copy-back failed: the added target already exists" >&2
      exit 1
    }
    DIR=$(dirname -- "$TARGET")
    D="$DIR"
    while [ ! -d "$D" ]; do
      CREATED="$CREATED$D
"
      D=$(dirname -- "$D")
    done
    mkdir -p -- "$DIR" || { cleanup_dirs; exit 1; }
  else
    [ -n "$ORIGINAL" ] && [ "$(git hash-object --no-filters -- "$TARGET" 2>/dev/null)" = "$ORIGINAL" ] || {
      echo "copy-back failed: the original changed" >&2
      exit 1
    }
  fi
  TMP=$(mktemp "$TARGET.XXXXXX") || { cleanup_dirs; exit 1; }
  if [ "$ADDED" = "$FILE" ]; then
    if [ "$(git -C "$REPO" ls-tree "$REVIEWED" -- "$FILE" | awk '{print $1}')" = "100755" ]; then
      MODE=0755
    else
      UMASK=$(umask)
      MODE=$(printf '%04o' $(( 0666 & ~0$UMASK )))
    fi
  else
    MODE=$(stat -L -c %a "$TARGET" 2>/dev/null ||
      stat -L -f %Lp "$TARGET" 2>/dev/null) || {
      echo "copy-back failed: the target mode is not readable" >&2
      rm -f -- "$TMP"
      cleanup_dirs
      exit 1
    }
  fi
  git -C "$REPO" show "$REVIEWED:$FILE" > "$TMP" &&
    chmod "$MODE" "$TMP" &&
    mv -f -- "$TMP" "$TARGET" || {
      rm -f -- "$TMP"
      cleanup_dirs
      exit 1
    }
  CREATED=""
else
  echo "copy-back failed: $FILE is in neither commit and the reviewed commit did not delete it" >&2
  exit 1
fi
```

Use bash, not a PowerShell version. `mktemp` creates the temporary file beside the target. The block refuses a path in neither commit, a failed lookup, a target that changed, and a path that matches more than one file. Each refusal exits 1 and leaves the target as it was. A failed delivery removes only the empty parent directories that it created for an added path, deepest first. `stat -c %a` reads the mode of a modified target on GNU, and `stat -f %Lp` reads it on BSD.

After the copy, check the delivered state. When `reviewed.head` holds `<path>`, compare the content hash of the delivered file with the blob, and compare the executable bit of the target with the reviewed mode:

```bash
git -C "<throwaway repository>" cat-file -e "<reviewed.head>^{commit}" 2>/dev/null || {
  echo "delivery check failed: the reviewed revision is not readable" >&2
  exit 1
}
DELETED=$(git -C "<throwaway repository>" -c core.quotePath=false diff --name-only --diff-filter=D "<import commit>" "<reviewed.head>" -- "<path>") || {
  echo "delivery check failed: the reviewed diff is not readable" >&2
  exit 1
}
[ -z "$DELETED" ] || [ "$DELETED" = "<path>" ] || {
  echo "delivery check failed: <path> matches more than one file" >&2
  exit 1
}
if [ -n "$DELETED" ]; then
  [ ! -e "<target>" ] || {
    echo "delivery check failed: the deleted target remains" >&2
    exit 1
  }
elif git -C "<throwaway repository>" cat-file -e "<reviewed.head>:<path>" 2>/dev/null; then
  git -C "<throwaway repository>" rev-parse "<reviewed.head>:<path>"
  git hash-object --no-filters -- "<target>"
  MODE=$(git -C "<throwaway repository>" ls-tree "<reviewed.head>" -- "<path>" | awk '{print $1}')
  [ -n "$MODE" ] || { echo "delivery check failed: the reviewed mode is not readable" >&2; exit 1; }
  REVIEWED_EXEC=0
  [ "$MODE" = "100755" ] && REVIEWED_EXEC=1
  TARGET_EXEC=0
  [ -x "<target>" ] && TARGET_EXEC=1
  [ "$REVIEWED_EXEC" = "$TARGET_EXEC" ] || {
    echo "delivery check failed: the executable bit differs" >&2
    exit 1
  }
else
  echo "delivery check failed: the reviewed commit did not delete <path>" >&2
  exit 1
fi
```

The two hashes must be equal, and `<target>` is executable exactly when the reviewed mode is `100755`. A deletion is proven only when the diff against `<import commit>` lists `<path>` as deleted; then the block exits 1 when `<target>` remains. An unreadable revision, a mistyped path, a remaining file, a different hash, or a different executable bit means that the delivered state is not the reviewed blob, so report it and do not call the delivery complete.

Remove the work tree after the copy, as [Removing a work tree](work-tree-removal.md) states. Then remove the throwaway repository. Never remove the work tree before the copy.
