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
5. If lstat of the home reports ENOENT, for any reason, `uninstall` takes no lock,
   reads and writes nothing, reports nothing to remove, and exits 0. It never
   creates the home (issue #570). No install can exist at a path that does not
   exist, so no data is lost. An install that creates the home after that check
   runs after the uninstall returned, as if the uninstall had come first. Any
   other lstat error takes the locked path, so no path runs a mutating uninstall
   without the lock.
6. Maintainer decision: this rule covers a Windows path that cannot name a
   directory, because Windows reports ENOENT for it. Such a home now reports
   nothing to remove instead of raising the origin/main error. This replaces the
   earlier rule that kept that error through hand-written Windows name checks.

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
