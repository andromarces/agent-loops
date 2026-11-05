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
work tree when the run ends. The worker preamble and the reviewer prompt tell the child never to read, print, or quote `.env` or another ignored secret file, and to keep a content search to tracked files (issue #1248). That rule is advisory, and the runtime does not detect a breach. Pass `--no-copy-local-files` on the init call to turn
the copy off. It is an init field, so a later call cannot change it.

When the task needs other ignored reference data of the main work tree, such as a downloaded
specification directory, pass `--copy-local-path <relative path>` on the init call, once for each path. The
path joins the copy and follows every rule above, and its files appear in `localFiles.copied`. The
init refuses an absolute path, a path that leaves the main work tree or passes through a symlink or a junction,
a path that holds a tracked file, a path that holds a file that is not ignored, and use with
`--no-copy-local-files`. A refused init writes no state and spawns no child. It is an init field too, so a later call cannot change it, and
`localFilesDiffer` covers the files.

The copy runs once. A later dispatch never replaces or refreshes a copied file. The init
stores the content hash of each copy in the run state only. Each later dispatch compares the
source and the copy with that hash.

The envelope reports `localFilesDiffer` as a list of `{path, changed}` entries. The key is
absent when neither side changed. `changed` is `source`, `copy`, `both`, or `unknown`.
`unknown` means the runtime could not prove a side, and it never means no change. A legacy
state with no init hash reports every copied path as `unknown`, and so does a failed read or
a missing file.

For `source`, the main work tree changed after init: refresh the copy by hand when it holds
no turn edit. For `copy`, a turn changed the copy: report a breach under `open`. The first
action checks whether the main work tree holds a newer rule file, such as `AGENTS.md`. Never
read, print, or quote the file to decide.
