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
   0 in both outcomes. `timedOut: true` marks a wait that ended on the bound with
   a check still pending, which is a completed read and not a read failure, so
   the parent reads the flag instead of losing the result. This follows the
   `unresolvedCompare` precedent in ADR 0009: a recorded gap keeps exit 0 and
   carries its own field.
3. The bound is in seconds, defaults to 300, and refuses 0, because an unbounded
   wait is the outcome the operation exists to prevent. A parent whose harness
   command timeout is smaller sets a smaller bound.
4. The operation reads status only. It writes no run state, needs no init, and
   changes nothing, so it is not a lifecycle operation and is absent from the
   `turns` history. It refuses `--role`, `--reason`, `--require-accept`, and
   `--require-ci`, which belong to the other operations.
5. A required check that has not started is absent from `gh pr checks
--required`, so an empty list is not a settled read. The wait keeps polling an
   empty list and returns it on the bound. A read the CLI cannot parse refuses
   with a reason instead of reporting an empty settled wait, so an unresolved
   read never reads as clean.
6. The interactive instructions name `agent-loop role wait-checks` as the only
   command the check status read covers, in place of the bare `gh` watch.

## Consequences

- A parent learns the bound from the CLI instead of from its harness, and a wait
  that outlasts the harness command timeout returns before it is killed.
- The wait ends when the checks settle, on the bound, or on a failed read. It
  does not fail on a pending check, so the parent still applies the rule that a
  pending check is not a finish condition.
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

## Authors

Andro Marces

## Links

- [Issue #329: Give the interactive required-check wait a stated bound](https://github.com/andromarces/agent-loops/issues/329)
- Implementation: `waitChecks` in `src/lib/check-wait.mjs`, the `wait-checks`
  operation in `src/role.mjs`, the help text in `src/cli.mjs`; tests in
  `tests/lib/check-wait.test.mjs` and `tests/role.wait-checks.test.mjs`;
  documented in `docs/orchestrator-instructions.md` and `README.md`
- [Issue #319: State the required-check wait per role and CLI](https://github.com/andromarces/agent-loops/issues/319)
- [PR #322](https://github.com/andromarces/agent-loops/pull/322)
- [ADR 0009: Declare a PR input on every run that is PR work](0009-declare-a-pr-input-on-every-run.md)
- [ADR Index](README.md)
