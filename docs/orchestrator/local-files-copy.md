# Local files copied into the work tree

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when `--cwd` is a linked work tree, when the task needs ignored reference data of the main work tree, and when an envelope carries `localFilesDiffer`.

When `--cwd` is a linked work tree, the init call copies the untracked local files
of the main work tree that `--cwd` ignores (agent instructions, harness
configuration, `.env`, and the other paths in
[Local files in a linked work tree](../reference/harness-entry-points.md#local-files-in-a-linked-work-tree))
into `--cwd`, before the
first child turn. A file already in `--cwd` is never replaced, and no symlink is
followed: a symlink in the main work tree is skipped and named. The init envelope reports the paths as `localFiles: {copied, skipped}`,
by name only, and a path in `skipped` is untracked in the main work tree but not
copied: the child does not have it. Do not read, print, or quote any copied file.
The copy duplicates secrets such as `.env` into the run work tree, so remove that
work tree when the run ends. Pass `--no-copy-local-files` on the init call to turn
the copy off. It is an init field, so a later call cannot change it.

When the task needs other ignored reference data of the main work tree, such as a downloaded
specification directory, pass `--copy-local-path <relative path>` on the init call, once for each path. The
path joins the copy and follows every rule above, and its files appear in `localFiles.copied`. The
init refuses an absolute path, a path that leaves the main work tree or passes through a symlink or a junction,
a path that holds a tracked file, a path that holds a file that is not ignored, and use with
`--no-copy-local-files`. A refused init writes no state and spawns no child. It is an init field too, so a later call cannot change it, and
`localFilesDiffer` covers the files.

The copy runs once. A later dispatch never replaces or refreshes a copied file, but it
compares each copied file with its source in the main work tree by hash and reports the
names that differ as `localFilesDiffer: [...]` in the envelope. The key is absent when no
copy differs. A copy differs when the main work tree changed the file after init, or when a
turn changed the copy: the report does not tell which. When the key appears, check whether
the main work tree holds a newer rule file, such as `AGENTS.md`, and tell the child to refresh
that file by hand when it holds no turn edit. Never read, print, or quote the file to decide.
