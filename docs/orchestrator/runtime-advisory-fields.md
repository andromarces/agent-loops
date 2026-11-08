# Runtime advisory fields of a reviewer envelope

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a reviewer or worker envelope carries `inheritedTmpdirEntries`, or a reviewer envelope carries `packageStoreEntries`.

- A reviewer envelope carries `inheritedTmpdirEntries` only when entries appeared directly in the
  inherited temporary directory or in a literal system temporary directory during the turn, such as
  a probe directory that a turn created there. A worker envelope carries it only for a literal
  system temporary directory, because a worker may legitimately write in the inherited one. The
  field names the entries, redacted like the test command output, and never their content, at most 20. It is a diagnostic: the directories are shared with other processes, the runtime cannot
  attribute an entry to the turn, and it does not delete one.
  Only the turn directories that this process created, matched by exact name, are left out, and
  only until the removal ends: a directory that the removal refused or failed on, such as a
  replacement of the turn directory, is listed. Every other entry of the one post-turn read is
  listed, an `al-` name too. The runtime reads the directories once after the last child call of the
  dispatch, with no re-read and no wait. The field creates no `open` item by itself, and it never
  refuses a finish.
  - On macOS the usual inherited directory is under `/var/folders` when `TMPDIR` is set. The
    report follows `os.tmpdir()`, the inherited directory, whatever path it names, and it also
    reads the literal system temporary directories that differ from it. The literal roots are
    `/tmp` and `/private/tmp` on POSIX, and there are none on Windows, where a Git Bash `/tmp`
    resolves to the inherited directory. A literal root that resolves to or holds the inherited directory is
    left out of the extra read, so one write gives one name.
  - An entry of a literal system temporary directory carries the prefix `literal-tmp/`, for example
    `literal-tmp/x` for a write to `/tmp/x` on macOS (issue #1713). The prompt forbids that write,
    and the field names it after the turn. The entry is unattributed like every other entry: the
    parent names it to the user and deletes nothing, because another process can hold the same name.
    A turn that reports its own leftover makes it actionable.
  - An entry that a turn explicitly reports as its own leftover stays actionable: report it under
    `open` and name the turn report. A runtime cleanup failure stays actionable: `removeTurnTmpdir`
    warns with the directory that it did not remove and says to delete it by hand. The runtime adds
    no envelope field for it.
  - An entry that is the turn directory of another agent-loop process on the host, such as a
    concurrent run, carries the prefix `registered/`, for example `registered/al-Ab1234`. A process registers each turn directory in the runs root with its device and
    inode, and the entry is marked only while it is still that directory.
    A turn can write a registration for a directory of its
    own, so the prefix is a hint and never proof: the entry stays listed, and the parent creates no
    item for it by itself.
  - The runtime cannot attribute an entry to a turn, so the parent cannot prove ownership. The
    parent deletes no entry that `inheritedTmpdirEntries` names, and removal stays with the user. A
    `Notes` line from a reviewer never makes an entry safe to delete.
  - Every reviewer turn that read the directory before it started carries the field. The turns
    are an ok turn, a handled error, a turn that a mutation or a snapshot error halted, and a
    canceled turn. A worker turn carries the field when a literal system temporary directory entry
    appeared, because it reads only those roots before the turn.
  - The `role dispatch` envelope and the state file `lastResult` carry it for a halted or
    interrupted dispatch.
  - A turn that cannot carry it is one whose process ended
    without a throw, for example a crash or a kill, and one whose before-read
    failed. A run that the next call marks `interrupted` after such an end
    has none.
- A reviewer envelope carries `packageStoreEntries` only when entries changed during the turn in
  the pnpm package store that `node_modules/.modules.yaml` of the work tree records as `storeDir`.
  The field means that store changed, whoever changed it. It never claims that the reviewer's
  install used that store: an install into a store other than the recorded one gives no field,
  whatever selected that store (`pnpm_config_store_dir`, `PNPM_HOME`, `XDG_DATA_HOME`, a config
  file, or a `--store-dir` flag), and so does a work tree that never ran an install. A recorded
  store that config selected is reported like any other.
  - The
    field names the entries, relative to the parent of the recorded `storeDir`, such as
    `v11/projects/<hash>`, `v11/links/<package>`, or `v11/index.db`, redacted like the test command
    output, and never their content, at most 20. It is advisory: the store is shared with
    other processes, so the runtime cannot attribute a change to the turn, and it does not revert
    one. The runtime reads names, sizes, and times only, never file content, within 5 seconds and
    10,000 entries per directory, the store root included, and the read stops at that bound: no file
    system call starts after it. A store that it cannot read within the bound carries no field. The
    recorded file is read up to 1 MiB. A file that is missing, unreadable, longer than that, or
    without a store, or not valid JSON, and a store path that is not absolute, carries no field.
  - The runtime parses the file strictly. The two reads of a turn must see the same root, or the
    turn carries no field. The read has its own bound and takes
    no turn signal. Every reviewer turn that read the store before it started carries the field: an
    ok turn, a handled error, a turn that a mutation or a snapshot error halted, and a canceled
    turn. The `role dispatch` envelope and the state file `lastResult` carry it for a halted or
    interrupted dispatch. Report `packageStoreEntries` under `open` in the finish summary, and do not treat
    it as a reason to reject.
