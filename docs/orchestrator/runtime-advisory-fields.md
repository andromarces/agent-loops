# Runtime advisory fields of a reviewer envelope

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a reviewer envelope carries `inheritedTmpdirEntries` or `packageStoreEntries`.

- A reviewer envelope carries `inheritedTmpdirEntries` only when entries appeared directly in the
  inherited temporary directory during the turn, such as a probe directory that the reviewer
  created there. The field names the entries, redacted like the test command output (ADR 0017),
  and never their content, at most 20. It is advisory: the directory is shared with other
  processes, so the runtime cannot attribute an entry to the turn, and it does not delete one.
  Only the turn directories that an agent-loop process on the host registered are left out, the
  turn directories of concurrent runs included (issue #1240, ADR 0069). A process registers each
  one in the runs root with its device and inode when it creates it, and withdraws it when the
  removal ends. The entry is left out only while it is still the registered directory, so a
  directory that the removal refused or failed on, such as a replacement of the turn directory,
  is listed. Any other name is listed, an `al-` name too, when no agent-loop process registered
  that directory. The runtime reads the directory once, after the last
  child call of the dispatch, a task-only turn in a replacement conversation included.
  Every reviewer turn that read the directory before it started carries the field: an ok turn, a
  handled error, a turn that a mutation or a snapshot error halted, and a canceled turn. The
  `role dispatch` envelope and the state file `lastResult` carry it for a halted or interrupted
  dispatch, and a headless run emits an `inherited-tmpdir` event with `fatal: true` for a fatal
  error, which the transcript keeps. A turn that cannot carry it is one whose process ended
  without a throw, for example a crash or a kill, because the before-read lives in memory, and
  one whose before-read failed. A run that the next call marks `interrupted` after such an end
  has none. Report it in the finish summary under `open`, and do not treat it as a reason to
  reject (issue #1024).
- A reviewer envelope carries `packageStoreEntries` only when entries changed during the turn in
  the pnpm package store that `node_modules/.modules.yaml` of the work tree records as `storeDir`.
  The field means that store changed, whoever changed it. It never claims that the reviewer's
  install used that store: an install into a store other than the recorded one gives no field,
  whatever selected that store (`pnpm_config_store_dir`, `PNPM_HOME`, `XDG_DATA_HOME`, a config
  file, or a `--store-dir` flag), and so does a work tree that never ran an install. A recorded
  store that config selected is reported like any other. The
  field names the entries, relative to the parent of the recorded `storeDir`, such as
  `v11/projects/<hash>`, `v11/links/<package>`, or `v11/index.db`, redacted like the test command
  output (ADR 0017), and never their content, at most 20. It is advisory: the store is shared with
  other processes, so the runtime cannot attribute a change to the turn, and it does not revert
  one. The runtime reads names, sizes, and times only, never file content, within 5 seconds and
  10,000 entries per directory, the store root included, and the read stops at that bound: no file
  system call starts after it. A store that it cannot read within the bound carries no field. The
  recorded file is read up to 1 MiB. A file that is missing, unreadable, longer than that, or
  without a store, or not valid JSON, and a store path that is not absolute, carries no field.
  pnpm 12.11.2 writes the file as JSON, and the runtime parses it strictly. The two reads of a
  turn must see the same root, or the turn carries no field. The read has its own bound and takes
  no turn signal. Every reviewer turn that read the store before it started carries the field: an
  ok turn, a handled error, a turn that a mutation or a snapshot error halted, and a canceled
  turn. The `role dispatch` envelope and the state file `lastResult` carry it for a halted or
  interrupted dispatch, and a headless run emits a `package-store` event with `fatal: true` for a
  fatal error. Report `packageStoreEntries` in the finish summary under `open`, and do not treat
  it as a reason to reject (issue #1045).
