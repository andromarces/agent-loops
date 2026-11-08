# 0108. Report a literal system temporary directory entry in the inherited temporary directory field

## Status

accepted

## Supersedes

This ADR partially supersedes [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md):

- Decision 1's scope. It read one directory, the inherited temporary directory, and named it in a reviewer envelope. The one post-turn read now also reads the literal system temporary directories that differ from the inherited one, and a worker turn carries the field for those roots.
- Decision 6's sentence that a write with an absolute path does not use the private directory. The write still bypasses the private directory, and on POSIX a write directly in a literal system temporary directory is now reported.

Decisions 2 to 5, the diagnostic contract, the `registered/` hint, the action rules, and the private turn directory work stay in force.

## Date

2026-11-09

## Context

A child turn can write a literal `/tmp` path. On macOS the inherited directory is under `/var/folders`, so `/tmp` is another directory, and `inheritedTmpdirEntries` did not read it. Issue #1596 observed a worker write `/tmp/x` on macOS and leave it, with no field naming it. Issue #1529 observed a Codex reviewer writing probe files through a Git Bash `/tmp`, which resolves to the inherited directory there, so that case was covered. Issue #1249 added the rule to the worker prompt, and issue #1596 pinned that wording with a test, but the prompt states a restriction and the runtime checked nothing. Issue #1713 asks for the enforced behavior.

The runtime cannot prevent an arbitrary shell command from naming a path. It can read the directory after the turn, as it already does for the inherited one.

## Decision

1. **Read the literal roots too.** On POSIX the one post-turn read also reads `/tmp` and `/private/tmp`, which are one directory through the macOS symlink. A root that does not resolve, that resolves to the inherited directory while that directory is read too, or that repeats a root already read is left out, so one write gives one name. A root that holds the inherited directory is read, so a write directly in `/tmp` is still seen when `TMPDIR` names a subdirectory such as `/tmp/<sub>`, and the before/after compare keeps a pre-existing entry and the inherited entry out. Windows reads none, because a Git Bash `/tmp` resolves to the inherited directory, which the inherited read covers.
2. **Name the root.** An entry of a literal root carries the prefix `literal-tmp/`, which no entry name can hold, so the parent can tell it apart from an inherited entry. The list stays redacted like the test command output and capped at 20 entries together with the inherited names.
3. **Every child turn.** A reviewer turn reads both the inherited directory and the literal roots. A worker turn reads the literal roots only, because a worker may legitimately write a PR body file in the inherited directory and that write is not a finding. When the inherited directory is itself a literal root, a worker turn reads it as a literal root and reports a new entry there as `literal-tmp/`, because the runtime cannot tell the allowed write to the variable from the forbidden literal path; the equal-root case then reports a new entry for both roles. The field keeps its name `inheritedTmpdirEntries`; no envelope field is added.
4. **Detect, not prevent.** The change reports the write after the turn. The prompt restriction and its recovery action stay, because the runtime cannot stop a command from naming the path.
5. **Keep the diagnostic contract.** The entry is unattributed: another process can hold the same name, no finish is refused, and an entry creates no automatic `open` item. The parent names it to the user, deletes nothing, and a turn that reports its own leftover makes it actionable. General system temporary directory cleanup stays out of scope (ADR 0095).

## Consequences

- A macOS worker or reviewer turn that writes directly in `/tmp` leaves a `literal-tmp/` name in its envelope, so the parent and the user can act on the write that the prompt forbids.
- A write directly in a literal root is reported when that root holds the inherited directory, so `TMPDIR=/tmp/<sub>` keeps the check.
- When the inherited directory is itself a literal root, a worker turn reports a new entry of it, which can be its own allowed write to the `TMPDIR` variable. The entry is a diagnostic with no automatic action, and the alternative reports nothing for that configuration.
- A Linux turn whose inherited directory is another path reads `/tmp`, which other processes also use. Those names are diagnostics, like every other unattributed entry, and they need no action.
- A name created and removed around the post-turn read stays unseen. A turn that crashes or is killed carries no field.
- A root that a turn creates and makes unresolvable, or a read that fails, gives no entry for that root. The inherited read failure keeps the whole snapshot null, so no false change is reported.
- Tests name the literal roots so the churn of the host's `/tmp` stays out of the assertion.

## Alternatives

1. **Prevent the write with a sandbox or a shell hook.** Not taken. The supported adapters run an arbitrary shell command, and no hook sees every write path on every adapter.
2. **Add a new envelope field for literal roots.** Not taken. The existing field is the same diagnostic read at the same point, and a second field would double the dispatch, state, and prompt surface for no new meaning.
3. **Read the literal roots for reviewer turns only.** Not taken. Issue #1596 observed the gap in a worker turn, which is the role that carries no inherited-directory report.
4. **Read the literal roots on Windows as well.** Not taken. A Git Bash `/tmp` there is the inherited directory, and `C:\Windows\Temp` is not a path the prompts forbid.

## Authors

Andro Marces

## Links

- [Issue #1713](https://github.com/andromarces/agent-loops/issues/1713)
- [PR #1721](https://github.com/andromarces/agent-loops/pull/1721)
- Related issues: #1249, #1529, #1596
- [ADR 0095: Report inherited temporary directory names as diagnostics, not open items](0095-report-inherited-tmpdir-names-as-diagnostics-not-open-items.md)
- [ADR 0068: Give the turn of every adapter a private temporary directory](0068-give-the-turn-of-every-adapter-a-private-temporary-directory.md)
- Implementation:
  - Source: `literalTmpdirRoots`, `snapshotInheritedTmpdir`, and `appearedInInheritedTmpdir` in `src/lib/tmpdir-entries.mjs`, `src/lib/turn-evidence-window.mjs`, `src/child-turn.mjs`
  - Tests: `tests/lib/tmpdir-entries.test.mjs`, `tests/child-turn.inherited-tmpdir.test.mjs`
  - Docs: `docs/orchestrator-instructions.md`, `docs/orchestrator/runtime-advisory-fields.md`, `docs/reference/role.md`
- [ADR Index](README.md)
