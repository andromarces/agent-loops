# Local files copied into the work tree

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when `--cwd` is a linked work tree, when the task needs ignored reference data of the main work tree, and when an envelope carries `localFilesDiffer` or `localSourceChangedInTurn`.

When `--cwd` is a linked work tree, the init call copies the untracked local files
of the main work tree into `--cwd`. It copies the files that `--cwd` ignores,
before the first child turn. The copied set, the exclusion rules, and the refusal conditions are in
[Local files in a linked work tree](../reference/harness-entry-points.md#local-files-in-a-linked-work-tree).
The init envelope reports the paths as `localFiles: {copied, skipped}`,
by name only. A path in `skipped` is untracked in the main work tree but not
copied: the child does not have it. Do not read, print, or quote any copied file.

Remove the run work tree when the run ends. Pass `--no-copy-local-files` on the init
call to turn the copy off. It is an init field, so a later call cannot change it.

The task can need other ignored reference data of the main work tree. Pass
`--copy-local-path <relative path>` on the init call, once for each path. A downloaded
specification directory is one example. The
path joins the copy and follows every rule in
[Local files in a linked work tree](../reference/harness-entry-points.md#local-files-in-a-linked-work-tree),
and its files appear in `localFiles.copied`. A refused init writes no state and spawns no child. It is an init field too, so a later call cannot change it, and
`localFilesDiffer` covers the files.

The copy runs once. No dispatch replaces or refreshes a copied file; only an explicit
`refresh-local` call writes a copy after init. The init
stores the content hash of each copy in the run state only. Each later dispatch compares the
source and the copy with that hash.

The envelope reports `localFilesDiffer` as a list of `{path, changed}` entries. The key is
absent when neither side changed. `changed` is `source`, `copy`, `both`, or `unknown`.

A side counts as changed when it is missing, unreadable, or its hash differs from the stored
hash. The stored hash is the init hash, or the hash of the last refresh. `unknown` means the
runtime cannot prove a side, and it never means no change. A legacy state with no init hash
reports every copied path as `unknown`.

For `source`, the main work tree changed after init. Run
`agent-loop role refresh-local --cwd "<work tree>" --path <path>` with the stored
`--parent-session` id when no `localSourceChangedInTurn` entry names it. The command writes the
source bytes over the copy and stores their hash. The copy keeps its prior mode, including the read-only attribute on Windows.

The command refuses a path that init did not copy, a missing or unreadable side, and a link at the
file or a parent component. It also refuses a copy that differs from its stored hash, a terminal
run, and a child role. A refused refresh writes nothing. It reports the path only, never the content
or a hash.

For `copy`, a turn changed the copy: report a breach under `open`. For `both`, report a breach under `open`.

Each worker and reviewer turn also hashes every copied source before and after its window. A
source that changed inside the window is reported on that turn's envelope as
`localSourceChangedInTurn: [path]`, by path only, at most 20 paths. The field is absent when no
source changed or the read failed. The read proves no actor: the user or another process can
change the source too.

Report a `localSourceChangedInTurn` path under `open`, and ask the user before any refresh.
Never read, print, or quote the file to decide.
