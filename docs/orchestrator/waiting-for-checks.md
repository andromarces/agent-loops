# Waiting for required checks

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before a run that ends with `--require-ci` dispatches its reviewer, when a reviewer reports a pending required check, and when `wait-checks` returns an error, `noRequiredChecks`, or `noCheckSource`.

## Waiting for required checks

When a run will end with `--require-ci`, wait for the required checks on the new
PR head to complete before you dispatch the reviewer. When a reviewer turn
reports a pending required check in `Checks`, wait for those checks to complete
before you call `finish`.

The wait is the status read the role rule excepts, and it changes nothing. The
runtime owns the bound, because `gh pr checks --watch` takes no timeout and a
shell `timeout` exists on neither Windows nor macOS by default:

```bash
agent-loop role wait-checks --cwd <dir> --pr <n> --head <sha> --timeout <seconds>
```

The command returns inside its own bound, before the command timeout your harness
applies to a shell command, and prints one JSON envelope on stdout. `--cwd` must
be inside a Git work tree, as it is for `dispatch`, because the read runs there:

```json
{
  "status": "ok",
  "pr": 42,
  "timedOut": false,
  "head": "0123456789abcdef0123456789abcdef01234567",
  "checks": [{ "name": "ci", "state": "SUCCESS", "bucket": "pass" }]
}
```

`head` names the commit that `checks` describe. `gh pr checks` queries by PR identity
and names no commit, so a wait that starts before GitHub moves the PR head to a new
commit, as right after a worker push or `gh pr update-branch`, or that sees the head
move away and back, can read the passing checks of another commit from it. The wait
therefore never takes a check state from `gh pr checks`. Each poll reads the PR head
`<sha>`, runs `gh pr checks` for its exit-code outcome, and then reads every state
from the check runs and commit statuses of `<sha>` itself, every page, by SHA. The
required wait judges each required context as the `--require-ci` gate does: the
contexts come from the repository rulesets (`integration_id`), classic branch
protection (`app_id`), and the names that `gh pr checks --required` lists, an
app-qualified context is satisfied only by a check run of that app, and the latest
matching entry decides. A context with no entry on `<sha>` is pending. The `--all`
wait judges the latest check run of each name and app, and the latest commit status
of each context of `<sha>`. So `checks` always describe `head` and no other commit,
even when the PR head moves during the wait.

The states of `<sha>` only make the outcome stricter. A failing state of `<sha>`
settles the wait. A pass needs both: the `gh pr checks` outcome must be a pass, and so
must every state of `<sha>`. A `gh pr checks` outcome that is pending (exit 8) or that
reports no check yet keeps the wait running while `<sha>` shows a pass, and it ends at
the bound with `timedOut: true`, never a pass.

A failure that `gh pr checks` lists settles the wait whatever `<sha>` shows. That
evidence is PR-level and is not pinned to `<sha>`, so it never goes into `checks`. It
is reported in `prFailures`, a field that appears only when `gh pr checks` listed a
failure in the poll that ended the wait. `checks` holds only states read for `head`.
Never record a pass from an envelope that carries `prFailures`: the failure may belong
to a commit other than `head`, and the parent decides what it means.

```json
{
  "status": "ok",
  "pr": 42,
  "timedOut": false,
  "head": "0123456789abcdef0123456789abcdef01234567",
  "checks": [{ "name": "ci", "state": "SUCCESS", "bucket": "pass" }],
  "prFailures": [{ "name": "ci", "state": "FAILURE", "bucket": "fail" }]
}
```

`prFailures` survives a bound that a later read reaches (`timedOut: true`) and a commit
or source read that fails. In the second case `head` is `null` and `checks` is empty,
because no state was read for a commit.

The required wait refuses a required context it cannot resolve. A ruleset or protection
source with no usable reply (a 403 or 404 for a caller without admin rights, for example), a
source reply that is not valid JSON, and a failed read of the required names each exit 1
with `status: "error"` (a server error of that read is retried, below) before any state is judged, including when `gh pr checks --required`
answers that the branch has no required check, because such a
source can hold a required check or an app qualifier that the wait never saw. A listed
failure still settles the wait in that case, as `prFailures`. The `--all` wait reads no
source. A commit read that fails, or that returns a reply the wait fails to parse or order,
is an error too, with one exception. The commit reads are the gate's own reads, and no read of the wait or the gate uses `gh --paginate`: each sends one `gh api --include` request per page, for the documented page number (`?per_page=100&page=N`), and never follows the `Link` header. The read does look at the `Link` header of every reply, a retryable 5xx included and before its status is judged, only to reject it: a target on a host other than the request host (`GH_HOST`, else the default host of `gh`, and its API host) or a target that is not a URL ends the read with an error, never a pass, and is never requested. Such a reply is terminal even when its status is 500, 502, 503, or 504: it is never retried. Each `gh` output then holds exactly one exchange, and `gh` writes the status line of that request first, followed by the headers, a blank line, and the body, so body bytes can only follow the status line and never form a status block of their own. The default host of `gh` is the one host of its configuration, or github.com for none or several. The read takes it from `gh auth status --json hosts`, run once per read for a reply that carries a `Link` target, with `GH_TOKEN` and `GITHUB_TOKEN` removed from that one call, because either variable adds github.com to the listing. A failed call and a reply of another shape name no host, so every target is then refused. Observed with `gh` 2.103.1 against a local server: a 403, a 502 with an empty, JSON, or HTML body, and a 403 whose body held a forged status block each wrote their own status line first, a redirect showed only the status line of its final reply, and `gh` itself rejected a 403 body that held extra bytes after one JSON value. The wait takes the status only from that first line and never reads the error text, which carries server-supplied text. A failed read is retried on the next poll, inside the bound, only when the first-line status is exactly 500, 502, 503, or 504 and the rest of stdout after the headers is empty or exactly one JSON value, and a pass on a later poll settles the wait. A successful page needs a 2xx first line and a remainder that is exactly one JSON value, checked on the whole remainder, so trailing bytes make the read an error. For an endpoint that reports `total_count`, such as the check runs, the read ends only when the collected count equals it: an empty or short page while the count is unmet, a `total_count` that changes or disappears between pages, and a collected count above it are each an error, never a pass, so a failure on a later page is never skipped. For an endpoint with no `total_count`, the first page of fewer than 100 items ends the read. The read stops with an error after 100 pages. Each page read stays inside the wait bound. Trade-off: a real 5xx whose body is HTML or plain text, as a proxy sends, stays terminal, because its body cannot be told apart from forged text. Relation to issue #1033: the `--require-ci` gate reads and the ruleset read page the same way, so no read follows a reply-supplied `Link` URL, and no request goes to a target that a reply named. A `Link` target on another host is an error for the gate reads, the ruleset read, and the wait alike, because they share one pager. Observed against github.com with `gh` 2.103.1 on Windows 11 (2026-10-24, #710): the gate reads of PR #1040 sent one `?per_page=100&page=1` request with `--include` for each of the ruleset, commit status, and check-run reads, with no `--paginate`, and a three-page read of `repos/cli/cli/releases` through the same pager accepted the `api.github.com` `Link` header of each reply and requested only `page=1` to `page=3`. A GitHub Enterprise host was not tested. A gate read that cannot be accounted for page by page is an error, and a ruleset read that cannot is an unknown source, never a pass. The pager hands the ruleset classifier every page it received, empty pages included, so ADR 0012 classes are unchanged: a full page of 100 rules followed by an empty page is unknown and refuses. Any other failure also ends the wait at once: another first-line status, such as 501 or a 4xx, whatever its body says, a failure with no status line, and a body that fails to parse. A later poll that completes replaces the error of an earlier one, whether it settles, skips its reads because the PR head is another commit than `--head`, or reads the commit. A wait that reaches the bound while the latest completed poll failed with a retryable status exits 1 with `status: "error"` and that error, with no `timedOut: true` and no pass, unless `gh pr checks` listed a failure in that poll, which `prFailures` reports with the bound as before. The retry covers `wait-checks` only: the `--require-ci` finish gate keeps failing closed on every read failure (issue #1025). `childExitUnconfirmed: true` covers every `gh` child of the poll, including a source
read that the first failure of the poll left running to the ceiling, and it rides on every
envelope, settled, timed out, or error. A required check that no
read of the PR lists yet is absent, as before.

The `gh pr` reads of a poll are retried on the next poll, inside the bound, when `gh` names
a server error (HTTP 500, 502, 503, or 504) as the opening of its error text, as in
`HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)` (#1121). These reads are the
head read (`gh pr view`) and the check list read (`gh pr checks`, with or without `--required`).
In the required wait the reply of the check list read also supplies the required names, so a poll
makes one `gh pr checks --required` call (#1125). A server error that lasts to the bound
exits 1 with `status: "error"` that names it, never `timedOut: true` and never a pass (#1025). A
read that fails with any other status, such as a 4xx, a failure whose text names no HTTP
status, a status that appears only after the opening of the text, and a failure that wrote
output the wait cannot parse, still ends the wait at once. The error that ends the wait at the
bound carries the `gh` error text, so it names the server status. This retry belongs to `wait-checks`: the `--require-ci`
finish gate reads the same names once and still fails closed.

The PR head is the one read at the start of the poll, so the PR can have moved on by
the time the wait returns. Compare `head` with the commit you expect before you record the
checks as passed.

Pass `--head <sha>` with the commit you expect, for example `workTree.head` of
the worker envelope. It takes a full lowercase commit SHA, 40 or 64 hex digits,
and refuses an abbreviation. While the PR head is another commit, the wait reads
no checks and continues. A wait that reaches the bound before the PR head reaches
`--head` returns `timedOut: true`, `head: null`, and an empty `checks`, which is
never a pass. Without `--head`, the wait settles on whatever the PR head is when a
poll starts. `head` is `null` only when no read completed.

`--timeout` is in seconds and defaults to 300. Set it below the command timeout
your harness applies when that timeout is smaller. `--timeout 0` is refused.

The bound starts at command entry, so no step of the command adds time to it.
Work-tree validation runs inside the bound, so a slow or hung `git` cannot push
the command past it; a validation that reaches the bound refuses, because a work
tree the probe never confirmed is not one this command may read. Every read is
limited to the time the command has left, and a read that reaches the limit is
stopped and then given five seconds to exit. The total bound of the command is
`--timeout` plus those five seconds, so set `--timeout` at least five seconds
below your harness command timeout. A wait that ends on the bound reports
`timedOut: true` with the last check states it read. It is a completed read, not
a read failure. An empty `checks` with `timedOut: true` means no check state was
ever read, so it never reads as a pass.

`childExitUnconfirmed: true` appears only when those five seconds expired with the
`gh` child still unaccounted for. The command does not claim an exit it did not
observe, so a `gh` process from an earlier wait may still be running; a parent
that sees it should settle the outstanding `gh` process before starting another
wait.

The `gh pr checks` exit codes decide the outcome, as the reviewer read states:
exit 0 with no pending check listed is settled, exit 8 is pending, and exit 1 is
settled only when the output lists a failing required check, or when `gh` prints
exactly `no required checks reported on the '<branch>' branch` and no output.
That one answer is its own outcome, below. Exit 1 with no output and exactly
`no checks reported on the '<branch>' branch` is an empty list: no check has
reported on the PR head yet, as right after a push. The wait continues, and the
poll also reads the required-check sources. If the rulesets and the classic protection
both settle nothing and no source names a check, as on a private repository on the
GitHub Free plan (#301), the required wait refuses at once on the first poll with the
unresolved-source error below, because no check can be known to report. A readable
source keeps the wait running, whether it names a required check or states the absence,
whatever the other source returned. The required names of that poll come from the same
`no checks reported` reply, which is no failure. A server error (500, 502, 503, 504) on a source read is
retried on the next poll, and one that lasts to the bound exits 1 with `status: "error"`.
If the bound arrives with only that reply, the wait returns `timedOut: true` and an
empty `checks`, which is never a pass. Any other exit 1, and any output that
is not a check list, is unresolved: the command exits 1 with
`status: "error"` and records no check state for that wait, so an unresolved
read never reads as a pass. Every check item is read as a name plus a `state` or
a `bucket` the CLI knows; an item that carries no readable state is unresolved
too, so one item the CLI cannot read cannot settle the wait as a pass. Never
record a check you could not read as passed.

A branch with no required check ends the wait at once with exit 0 and
`"noRequiredChecks": true`, an empty `checks`, and `"timedOut": false`. The wait
reports it only when every required-check source states the absence, as the
`--require-ci` gate decides it: `gh` answers that the branch has no required check,
the rulesets read has a rule but no required-status-check rule, and the classic
protection read states the branch is not protected. A source that settles nothing, as
the 403 of a private repository on the GitHub Free plan does, and a ruleset read that
found no rule with no source naming a check, exit 1 with `status: "error"`, because
the gate refuses the same states. A source that names a required
check is no absence, even beside a ruleset read that found no rule, and the wait
continues to judge that check:

```json
{
  "status": "ok",
  "pr": 213,
  "timedOut": false,
  "noRequiredChecks": true,
  "head": "0123456789abcdef0123456789abcdef01234567",
  "checks": []
}
```

It is not a read error and not a pass, because no check was read. There is
nothing required to wait for, so do not run the required wait again. On
`noRequiredChecks`, run `agent-loop role wait-checks --all` once, then dispatch the
reviewer, which reads the CI status of the PR head itself, and never record the CI
status as passed from the `noRequiredChecks` envelope. A reviewer that starts
before CI completes can report the CI status as unresolved, which the `--all`
wait avoids. The `--require-ci` gate still decides the finish; it reads the same
sources, so it does not refuse a `noRequiredChecks` branch for an unreadable source.

When no source can state the required checks, the required wait cannot say whether the
PR holds a required check, so it refuses with exit 1 and `status: "error"`. The error
says that a source `settled nothing`, that a source `could not be read`, or that a source
`did not state that it holds no required check`, and that the required checks of the PR
are unresolved. The 403 of a private repository on the GitHub Free plan (#301) is that
case. It is no required-check read, so do not run the required wait again. Run the
`--all` wait below once, as after `noRequiredChecks`, then dispatch the reviewer, which
reads the CI status of the PR head itself. An `--all` pass is never a required-check
pass: never record the CI status as passed from it, from this refusal, or from a
`noRequiredChecks` envelope. The `--require-ci` gate still decides the finish, and it
refuses a declared run there. Any other `status: "error"` stays an unresolved read,
including a reply that could not be parsed and a failed read of the required check names:
do not run `--all` for it.

```bash
agent-loop role wait-checks --all --cwd <dir> --pr <n> --head <sha> --timeout <seconds>
```

`--all` waits on every check of the commit `head` names, not only the required
ones. A check that a third-party app registers late is absent until it starts, so
an `--all` pass can come before it. For a late check that you know by name, such as
a deployment check, add `--expect "<check name>"` to `--all` once per name:

```bash
agent-loop role wait-checks --all --expect "<check name>" --cwd <dir> --pr <n> --head <sha> --timeout <seconds>
```

The wait does not pass until each named check has a check run on `head`. A name
matches the name of a check run exactly: it is trimmed, case-sensitive, and any
app qualifies. A commit status of that name never matches, though commit statuses
still count in the overall pass evaluation. An empty name is refused, and a
repeated name is accepted. A name that
never registers ends the wait at the bound with `timedOut: true` and the name in
`awaiting`, which is never a pass. A failing check still settles the wait at
once. `--expect` needs `--all` and is refused on every other operation.
It runs `gh pr checks <pr>` without `--required`, so it keeps the bound and
the exit-code rules above, and the states of the commit only make them stricter: exit 0 with no pending check listed is settled, exit 8 is pending, a
listed failing check is settled, and every other exit 1 is unresolved with
`status: "error"`. Exit 1 with no output and exactly `no checks reported on the
'<branch>' branch` is the exception, as in the required wait: no check has
reported yet, so the wait continues. At the bound with only that reply, `--all`
returns `timedOut: true` and an empty `checks`, which is never a pass. A
repository with no CI workflow therefore waits the full `--timeout` before it
returns, unless `noCheckSource` ends the wait, as stated below. Exit 1 with `no required checks reported on the '<branch>' branch` stays
unresolved, because `--all` has no required-check answer. A `noRequiredChecks`
envelope never comes from `--all`. Use `--all` only after `noRequiredChecks`
or after the refusal above that no source states the required checks; when the
required wait reads a required check, it stays the one to run. `--all` is
refused on every other role operation, and so is `--head`. `--all` takes `--head`
as the required wait does.

The `--all` wait also asks once whether any source can report a check for the PR
head. It asks when the first read lists no check, no `--expect` name is set, and the
read of the PR head by SHA finds no check run and no commit status. The command reads
the files of the PR, the workflow files of the base branch, and the check runs and
commit statuses of the base head and of the head of the latest merged PR of that
commit (every head that shares the latest merge time), and you read none of them.
When all three conditions hold, the wait returns at once with `noCheckSource: true`,
`timedOut: false`, and an empty `checks`:

- The PR changes no file under `.github/workflows/`, a rename out of it included.
- No workflow file of the base branch names `pull_request`, `pull_request_target`,
  `push`, `merge_group`, `workflow_run`, or `check_suite`. The command scans the text
  of each file, so a name in a comment or a step keeps the wait. A file with a
  backslash or a control character, or one that is not valid UTF-8 or valid base64,
  keeps the wait too, because a YAML escape can spell an event name. A reusable
  workflow inherits the events of its caller, and the callers are files of the same
  directory. A file that names a trigger is passed over only when the
  whole file is one well-formed YAML document, every event under its `on` key is
  `pull_request` or `pull_request_target`, each has a `paths` list, and no PR file
  matches a pattern under the GitHub filter rules, because that workflow cannot run
  for the PR (#1065). Any other event, `push` included, `paths-ignore`, a pattern
  that the command cannot settle (a `!` negation, `?`, `+`, `[...]`), a syntax
  error anywhere in the file, a second document, a duplicate key, a tag on any node (`!!str` and `!!map` included), an anchor, an alias,
  and a PR file name with a control character, a line separator, or a lone surrogate
  keep the wait. The command validates YAML syntax, not the schema of a workflow, so
  a file that is well-formed YAML but that GitHub rejects for another reason is
  still passed over.
- The base head, and the head of the latest merged PR of that commit, have no check run
  and no commit status from any source, because a GitHub App or third-party CI can
  report a check with no workflow file, and one can report on PR heads only.

`noCheckSource` is never a pass. On it, dispatch the reviewer at once, record in
`verified` that the CI status is not verified, and never record the CI status as
passed. Act only on the field: never read a workflow file, a PR file list, or a check
source yourself to decide it. A read that fails, cannot be parsed, is incomplete, or is
not settled keeps the normal wait, so an envelope without the field keeps every rule
above. A list at its API cap (3,000 PR files, 1,000 workflow files) is incomplete, and
a base branch or PR head that moves during the reads keeps the wait, and so does a merged PR entry that
is malformed. A
repository with a `pull_request` workflow keeps the wait, unless a `paths` filter keeps that workflow from running for every file of the PR. The limit: the base head and
one merged PR head are two commits, so a provider that skipped both stays unseen, and
only the wait covers it. `noCheckSource` never comes from the required
wait. The headless orchestrator prompt carries the same rule.

A `bucket` of `pending` marks a pending check, and `fail` or `cancel` marks a
failed one. A check that has not started is absent from `checks`, because the
command omits it, so an empty list means no required check has reported yet and
the wait continues.

A required check still pending after a wait, whether it failed or the bound
elapsed, is not a finish condition. The `--require-ci` gate refuses a finish
while a required check is pending, so a finish summary cannot carry it. Wait
again, dispatch the reviewer again, or `abort` with the pending check named in
the reason.

## Headless loop waits

The headless `agent-loop` command runs its own orchestrator and renders its own wait
prompt (ADR 0013). A `role` parent does not follow that prompt. It follows the wait
rules above, and it runs the wait itself.

The `--require-ci` finish gate is the only check read that enforces; the advisory status read of a named PR does not. The gate refuses a finish while a required check is pending. A reviewer dispatch corrects that refusal.
