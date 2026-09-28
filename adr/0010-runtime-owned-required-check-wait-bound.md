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
4. The bound covers the reads, not only the pauses. Each read is limited to the
   time the wait has left, and a read that reaches the limit is signaled to stop.
   `runGh` carries that limit to `execa` as `timeout`, with `cleanup` and
   `killDescendants`, so the `gh` child is terminated rather than left running:
   `SIGTERM` then `SIGKILL` after one second on macOS, and `taskkill /T /F` over
   the process tree on Windows.
5. The `gh pr checks` exit codes decide the outcome, as the reviewer read states
   them: exit 0 with no pending check listed is settled, exit 8 is pending, and
   exit 1 is settled only when the output lists a failing required check, because
   exit 1 also covers a repository with no required check and a read error. Any
   other exit 1, and any output that is not a check list, refuses with a reason,
   so an unresolved read never reads as a pass.
6. The operation reads status only. It writes no run state, needs no init, and
   changes nothing, so it is not a lifecycle operation and is absent from the
   `turns` history. It refuses `--role`, `--reason`, `--require-accept`, and
   `--require-ci`, which belong to the other operations.
7. `--cwd` must be inside a Git work tree, by the same `assertGitWorkTree` rule
   `dispatch` applies, because the read runs in that work tree.
8. A required check that has not started is absent from `gh pr checks
--required`, so an empty list is not a settled read. The wait keeps polling an
   empty list on exit 0 or exit 8, and returns it on the bound. The same empty
   list on exit 1 is a different case, and refuses.
9. The interactive instructions name `agent-loop role wait-checks` as the only
   command the check status read covers, in place of the bare `gh` watch.

## Consequences

- A parent learns the bound from the CLI instead of from its harness, and a wait
  that outlasts the harness command timeout returns before it is killed.
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
   inside the runtime.

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
