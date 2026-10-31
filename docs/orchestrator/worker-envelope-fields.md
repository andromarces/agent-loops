# Advisory fields of a worker envelope

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a worker envelope carries `sharedGitChanged` or `lockfileChanged`.

- A worker envelope carries `sharedGitChanged` only when the turn changed shared Git state outside
  the work tree: `core.hooksPath`, a file in the common `hooks/` directory, or a remote. The field
  names the items, such as `core.hooksPath`, `hooks/pre-push`, and `remote.origin`, and never a
  value or a URL. A change there affects the main work tree and every other linked work tree, and
  `workTree` does not show it. Report it in the finish summary under `open`. A failed or canceled
  worker turn carries the field too. A turn that changed none carries no field. A read of the
  shared Git state that fails or passes its 10 second deadline after the turn reports no field, so
  the absent field then does not prove that no change happened. The runtime logs a warning for
  such a read.
- A worker envelope carries `lockfileChanged` only when the turn changed a lockfile at the work
  tree root, for example `pnpm-lock.yaml` after a merge of the base branch. The field names the
  lockfiles by path only. A lockfile that the runtime could not read before or after the turn counts
  as changed. When the runtime could not read the work tree root, the field names every lockfile,
  which can include a lockfile that does not exist: reinstall anyway (issue #1225). The worker
  never installs, so the installed dependencies no longer match
  the lockfile. When the field appears, run the lockfile install in that work tree, for example
  `pnpm install --frozen-lockfile`, before the next reviewer dispatch (issue #1180). A failed worker
  turn carries the field too. A turn that changed none carries no field.
