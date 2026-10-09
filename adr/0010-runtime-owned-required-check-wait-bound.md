# 0010. A runtime-owned bound on the interactive required-check wait

## Status

accepted

## Date

2026-09-28

## Context

`docs/orchestrator-instructions.md` told an interactive parent to wait for the
required checks with `gh pr checks <pr> --required --watch` and to "keep the wait
inside the command timeout your harness applies to a shell command". No
repository file set that bound, and it differs per harness, so a parent could not
know it from the CLI. A watch that outlasts it is killed by the harness and the
parent sees no result. The headless loop already had a stated bound
(`--timeout`, default 3600 seconds); the interactive path had none
(issue #329, deferred from #319).

The wait cannot be bounded in the shell as the docs implied. `gh pr checks
--watch` takes no timeout, and a shell `timeout` is absent from both platforms
the repository supports: Windows ships `timeout` as a sleep command, and macOS
ships no GNU coreutils, so a bound needs a second installation there.

## Decision

1. `agent-loop role wait-checks --pr <pr> [--cwd <dir>] [--timeout <seconds>]`
   is a new role operation that owns the wait and its bound. It polls
   `gh pr checks <pr> --required --json name,state,bucket` until no required
   check is pending or the bound elapses.
2. The envelope is `{ "status": "ok", "pr": <pr>, "timedOut": <boolean>,
   "checks": [{ "name", "state", "bucket" }] }` on stdout, and the command exits
   0 when the read resolved. `timedOut: true` marks a wait that reached the bound,
   which is a completed read and not a read failure, so the parent reads the flag
   instead of losing the result. This follows the `unresolvedCompare` precedent in
   ADR 0009: a recorded gap keeps exit 0 and carries its own field.
3. The bound is in seconds, defaults to 300, and refuses 0, because an unbounded
   wait is the outcome the operation exists to prevent. A parent whose harness
   command timeout is smaller sets a smaller bound.
4. The bound starts at command entry, so no step of the command adds time to it.
   The total bound of the command is the bound plus `CHILD_EXIT_CEILING_MS`, five
   seconds: after the bound, a read that was cut short is given that ceiling to
   exit. A parent sets a bound at least five seconds below its harness command
   timeout.
5. Work-tree validation runs inside the same bound. `assertGitWorkTree` takes the
   remaining time and carries it to `execa` as `timeout`, with `cleanup` and
   `killDescendants`, so a slow or hung `git` is terminated rather than left
   adding its own time to the command, and the command also races the probe
   against that bound. A validation that reaches the bound refuses, because a
   work tree the probe never confirmed is not one the command may read.
6. Each read is limited to the time the wait has left, and a read that reaches
   the limit is signaled to stop. `runGh` carries that limit to `execa` as
   `timeout`, with `cleanup` and `killDescendants`, so the `gh` child is
   terminated rather than left running: `SIGTERM` then `SIGKILL` after one second
   on macOS, and `taskkill /T /F` over the process tree on Windows.
7. A child exit is reported only when it was observed. When the five-second
   ceiling expires with the read still unaccounted for, the envelope carries
   `childExitUnconfirmed: true`, which follows the `unresolvedCompare` precedent:
   a recorded gap keeps exit 0 and carries its own field, and the field is
   absent when the exit was observed. The command makes no claim it cannot
   support, and a parent that reads the field settles the outstanding `gh`
   process before starting another wait.
8. The `gh pr checks` exit codes decide the outcome, as the reviewer read states
   them: exit 0 with no pending check listed is settled, exit 8 is pending, and
   exit 1 is settled only when the output lists a failing required check, because
   exit 1 also covers a repository with no required check and a read error. Any
   other exit 1, and any output that is not a check list, refuses with a reason,
   so an unresolved read never reads as a pass.
9. Every check item is validated: it must carry a non-empty `name` and at least
   one of `state` or `bucket`, and every value it carries must be one the CLI
   documents. An item that fails any of those checks is unresolved, so an item
   the runtime cannot read can never settle the list as a pass.
10. The operation reads status only. It writes no run state, needs no init, and
    changes nothing, so it is not a lifecycle operation and is absent from the
    `turns` history. It refuses `--role`, `--reason`, `--require-accept`, and
    `--require-ci`, which belong to the other operations.
11. `--cwd` must be inside a Git work tree, by the same `assertGitWorkTree` rule
    `dispatch` applies, because the read runs in that work tree. The rule is
    injected into the operation, so a test can spend clock time on validation and
    check that the time comes out of the bound.
12. A required check that has not started is absent from `gh pr checks
    --required`, so an empty list is not a settled read. The wait keeps polling an
    empty list on exit 0 or exit 8, and returns it on the bound. The same empty
    list on exit 1 is a different case, and refuses.
13. The interactive instructions name `agent-loop role wait-checks` as the only
    command the check status read covers, in place of the bare `gh` watch.

## Consequences

- A parent learns the bound from the CLI instead of from its harness, and a wait
  that outlasts the harness command timeout returns before it is killed.
- The total bound is the bound plus the five-second child-exit ceiling, so the
  parent sets a bound five seconds below its harness command timeout, not at it.
  No step of the command, validation included, adds time to it.
- `childExitUnconfirmed: true` means a `gh` process may still be running. The
  command reports that instead of claiming an exit, and the parent owns the
  cleanup. A parent that never sees the field never had an unobserved exit.
- The wait ends when the checks settle, on the bound, or on an unresolved read
  that exits 1. It does not fail on a pending check, so the parent still applies
  the rule that a pending check is not a finish condition.
- A read that is abandoned on the bound reports the last check states that were
  read, which can be none. An empty `checks` with `timedOut: true` therefore
  means no required check state was ever read, not that the checks passed.
- The operation polls at a fixed 15-second interval, with no flag to change it.
  A check that settles is reported within one interval of its completion.
- The headless wait is unchanged. A headless orchestrator turn still runs
  `gh pr checks --watch` inside its own turn bound.

## Alternatives

1. **State a fixed recommended bound in the docs with a shell `timeout`**: the
   option the issue names, and it needs no new code. Rejected; the command
   cannot work on both supported platforms, because Windows `timeout` is a sleep
   and macOS has no GNU coreutils by default. A documented command that fails on
   one platform is worse than a runtime-owned bound.
2. **Add `--timeout` to the `gh` watch**: not available; `gh pr checks` exposes
   `--watch`, `--fail-fast`, and `--interval` only.
3. **Make the wait a lifecycle operation that records a turn**: rejected; the
   wait reads status and changes nothing, so a turn entry would charge a step for
   a read.
4. **Exit non-zero on a bound that elapsed**: rejected for the same reason
   `unresolvedCompare` keeps exit 0 on the interactive path. A parent must be
   able to tell the two outcomes apart, and it reads that from `timedOut`.
5. **Treat every `gh` answer as a check list and read the buckets alone**: the
   first review rejected it. An exit 1 carries no required check and a read error
   as well as a failing check, and an empty list on either is indistinguishable
   from a clean answer, so a broken read would read as a pass. The exit code and
   the check list together decide.
6. **Leave the child to the harness**: the first review rejected it too. A wait
   that abandons a read still leaves a `gh` process behind, and a parent that
   waits repeatedly accumulates one per wait, so the read is bounded and stopped
   inside the runtime, and the command then waits for the child to exit up to a
   stated ceiling.
7. **Return at once on a bound that elapsed**: the second review rejected it. A
   command that returns while its `gh` child is still alive hands the next wait a
   second live read, and a parent that waits repeatedly accumulates them, so the
   command confirms the child exit up to a ceiling it states.
8. **Bound only the reads, starting the clock at the first read**: the second
   review rejected it. Work-tree validation runs inside the command, so a bound
   that starts after it lets the command run for validation time plus the bound,
   which is the overage the bound exists to prevent.
9. **Leave the work-tree probe unbounded because it is a local `git` call**: the
   third review rejected it. A slow or hung `git` adds its own time to the
   command, so the probe runs inside the bound, is terminated on the bound, and
   refuses when it cannot confirm the work tree.
10. **Return at the ceiling as if the child had exited**: the third review
    rejected it. That states an exit the command never observed, and a parent
    would read it as a clean machine. The ceiling outcome is reported as
    `childExitUnconfirmed`, and the parent owns the cleanup.

## Authors

Andro Marces

## Links

- [Issue #329: Give the interactive required-check wait a stated bound](https://github.com/andromarces/agent-loops/issues/329)
- Implementation: `waitChecks` in `src/lib/check-wait.mjs`, the bounded runner
  in `runGh` and `src/lib/ci-gate.mjs`, the `wait-checks` operation in
  `src/role.mjs`, the help text in `src/cli.mjs`; tests in
  `tests/lib/check-wait.test.mjs`, `tests/role.wait-checks.test.mjs`, and
  `tests/lib/ci-gate.test.mjs`; documented in
  `docs/orchestrator-instructions.md` and `README.md`
- [Issue #319: State the required-check wait per role and CLI](https://github.com/andromarces/agent-loops/issues/319)
- [PR #322](https://github.com/andromarces/agent-loops/pull/322)
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
- [ADR Index](README.md)
