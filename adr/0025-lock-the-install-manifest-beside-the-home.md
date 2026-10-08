# 0025. Lock the install manifest beside the install home

## Status

accepted

## Date

2026-10-07

## Context

Issue #193 serialized `install` and `uninstall` with a lock file under
`tmpdir()`, keyed by a hash of the install home. It kept the home free of lock
files. Two processes with different `TMPDIR` or `TEMP` values compute different
lock paths and do not contend, so concurrent commands across two temp roots can
overwrite each other's manifest records. A sandboxed harness can set its own temp
directory, so the case is reachable (issue #198).

## Decision

1. The lock is `<home>/.agent-loops.lock`, the install home that `AGENT_LOOP_HOME`
   or `homedir()` names. It sits beside `<home>/.agent-loops`, not inside it, so
   `removeManifest` can delete the directory while the lock is held.
2. The lock is keyed by location: no hash, no Windows case handling, and no
   dependence on any temp setting. It is acquired with the existing
   `withStateLock`, so the dead-pid check recovers a stale lock.
3. The lock is removed in a `finally`, so a full uninstall leaves the home empty
   and the CI empty-home check holds.
4. A dry run takes no lock and writes nothing.
5. An uninstall on a home that is valid and absent returns no reports without a
   lock, a read, or a write. It has nothing to remove, so it must not create the
   home (issue #570). No path runs a mutating uninstall without the lock. An
   install that creates the home after that check runs after the uninstall
   returned, as if the uninstall had come first. The home counts as missing only
   when lstat reports ENOENT and, on Windows, the root exists and every name is
   legal, because Windows also reports ENOENT for an invalid path. Any other home
   takes the locked path, so its error surfaces as before.

## Consequences

- Two processes with different temp roots contend on one lock for one home.
- A crash leaves `<home>/.agent-loops.lock` until the next command recovers it.
- This reverses the preference of #193 to keep the home free of lock files. The
  reason: install must write the home anyway, so a sandbox that blocks the home
  cannot install, and the lock adds no new write permission.
- A real `uninstall` on a home that does not exist writes nothing and leaves no
  directory behind.

## Alternatives

- A fixed per-user lock directory (`XDG_RUNTIME_DIR`, `~/Library/Caches`,
  `%LOCALAPPDATA%`). Rejected: more platform code, and a sandbox can block those
  directories where install works today. A fallback to `tmpdir()` reintroduces
  this issue.
- Keep `tmpdir()` and document that callers share one temp root. Rejected: it
  leaves the data-loss case open.

## Authors

Andro Marces

## Links

- Issue #198, issue #193, issue #570, PR #197
- Pull request: [PR #561](https://github.com/andromarces/agent-loops/pull/561)
- Implementation: `manifestLockFile` in `src/install/manifest.mjs`
