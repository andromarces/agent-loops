# Waiting for required checks

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before a run that ends with `--require-ci` or `--compare-head` waits for checks, and when a reviewer reports a pending required check. Read it when a required check fails on a known flaky test. Read it when `wait-checks` returns an error, `noRequiredChecks`, or `noCheckSource`.

## Waiting for required checks

When a run will end with `--require-ci`, wait for the required checks on the new
PR head to complete before you dispatch the reviewer. When a reviewer turn
reports a pending required check in `Checks`, wait for those checks to complete
before you call `finish`.

The wait is the status read the role rule excepts, and it changes nothing (issue #348). The
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
from the check runs and commit statuses of `<sha>` itself, every page, by SHA.

The required
wait judges each required context as the `--require-ci` gate does: the
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
is an error too, with one exception. The commit reads are the gate's own reads, and no read of the wait or the gate uses `gh --paginate`: each sends one `gh api --include` request per page, for the documented page number (`?per_page=100&page=N`), and never follows the `Link` header.

The read does look at the `Link` header of every reply, a retryable 5xx included and before its status is judged, only to reject it: a target on a host other than the request host (`GH_HOST`, else the default host of `gh`, and its API host) or a target that is not a URL ends the read with an error, never a pass, and is never requested. Such a reply is terminal even when its status is 500, 502, 503, or 504: it is never retried. Each `gh` output then holds exactly one exchange, and `gh` writes the status line of that request first, followed by the headers, a blank line, and the body, so body bytes can only follow the status line and never form a status block of their own. The default host of `gh` is the one host of its configuration, or github.com for none or several. The read takes it from `gh auth status --json hosts`, run once per read for a reply that carries a `Link` target, with `GH_TOKEN` and `GITHUB_TOKEN` removed from that one call, because either variable adds github.com to the listing. A failed call and a reply of another shape name no host, so every target is then refused.

Observed with `gh` 2.103.1 against a local server: a 403, a 502 with an empty, JSON, or HTML body, and a 403 whose body held a forged status block each wrote their own status line first, a redirect showed only the status line of its final reply, and `gh` itself rejected a 403 body that held extra bytes after one JSON value. The wait takes the status only from that first line and never reads the error text, which carries server-supplied text. A successful page needs a 2xx first line and a remainder that is exactly one JSON value, checked on the whole remainder, so trailing bytes make the read an error. For an endpoint that reports `total_count`, such as the check runs, the read ends only when the collected count equals it: an empty or short page while the count is unmet, a `total_count` that changes or disappears between pages, and a collected count above it are each an error, never a pass, so a failure on a later page is never skipped. For an endpoint with no `total_count`, the first page of fewer than 100 items ends the read.

A failed read is retried on the next poll, inside the bound, only when the first-line status is exactly 500, 502, 503, or 504. A pass on a later poll settles the wait. The retried body classes are empty, JSON, and truncated JSON.

A failed 5xx read names its body class in the error: empty, JSON, truncated JSON, unparseable JSON, or other text. The error carries only the status and the class, never the server-supplied text and never a body byte. A 5xx with a truncated JSON body is retried inside the bound. A cut-short JSON value is a GitHub-shaped reply that a transient failure truncated, and the body never decides the status. The forged-text trade-off of #1025 keeps an unparseable or other-text body terminal, because its bytes cannot be told apart from forged text.

A proxy or a forged body can also enter the truncated class, because its opening bytes can look like JSON. A retry inside the bound is still safe. A retry never yields a pass by itself, and the bound still ends in an error.

The read stops with an error after 100 pages. Each page read stays inside the wait bound. Trade-off: a real 5xx whose body is HTML or plain text, as a proxy sends, stays terminal, because its body cannot be told apart from forged text. Relation to issue #1033: the `--require-ci` gate reads and the ruleset read page the same way, so no read follows a reply-supplied `Link` URL, and no request goes to a target that a reply named. A `Link` target on another host is an error for the gate reads, the ruleset read, and the wait alike, because they share one pager. Observed against github.com with `gh` 2.103.1 on Windows 11 (2026-10-24, #710): the gate reads of PR #1040 sent one `?per_page=100&page=1` request with `--include` for each of the ruleset, commit status, and check-run reads, with no `--paginate`, and a three-page read of `repos/cli/cli/releases` through the same pager accepted the `api.github.com` `Link` header of each reply and requested only `page=1` to `page=3`.

A GitHub Enterprise host was not tested. A gate read that cannot be accounted for page by page is an error, and a ruleset read that cannot is an unknown source, never a pass. The pager hands the ruleset classifier every page it received, empty pages included, so ADR 0012 classes are unchanged: a full page of 100 rules followed by an empty page is unknown and refuses. Any other failure also ends the wait at once. That covers another first-line status, such as 501 or a 4xx, whatever its body says. It also covers a failure with no status line, and a body that is unparseable JSON or other text.

A later poll that completes replaces the error of an earlier one, whether it settles, skips its reads because the PR head is another commit than `--head`, or reads the commit. A wait that reaches the bound while the latest completed poll failed with a retryable status exits 1 with `status: "error"` and that error, with no `timedOut: true` and no pass, unless `gh pr checks` listed a failure in that poll, which `prFailures` reports with the bound as before.

The retry covers `wait-checks` only: the `--require-ci` finish gate keeps failing closed on every read failure (issue #1025). `childExitUnconfirmed: true` covers every `gh` child of the poll, including a source
read that the first failure of the poll left running to the ceiling, and it rides on every
envelope, settled, timed out, or error. A required check that no
read of the PR lists yet is absent, as before.

The `gh pr` reads of a poll are retried on the next poll, inside the bound, when `gh` names
a server error (HTTP 500, 502, 503, or 504) as the opening of its error text, as in
`HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)` (#1121). These reads are the
head read (`gh pr view`) and the check list read (`gh pr checks`, with or without `--required`).
In the required wait the reply of the check list read also supplies the required names, so a poll
makes one `gh pr checks --required` call (#1125). A server error that lasts to the bound
exits 1 with `status: "error"` that names it, never `timedOut: true` and never a pass (#1025).

A read that fails with any other status, such as a 4xx, a failure whose text names no HTTP
status, a status that appears only after the opening of the text, and a failure that wrote
output the wait cannot parse, still ends the wait at once. The error that ends the wait at the
bound carries the `gh` error text, so it names the server status. This retry belongs to `wait-checks`: the `--require-ci`
finish gate reads the same names once and still fails closed.

A read that fails with no HTTP status and names a known transport failure is retried on the next
poll. Examples are `dial tcp ...: connect: operation timed out`, `connection reset by peer`, and
the bare `EOF` after a quoted URL. A bare `EOF` counts only at the end of the text, after a quoted
URL. A failure that lasts to the bound exits 1 with `status: "error"` that names it, never
`timedOut: true`. A 4xx, a status line, a foreign-host `Link` refusal, a reply body, and an unknown
text stay terminal.

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
below your harness command timeout.

A wait that ends on the bound reports
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
poll also reads the required-check sources.

If the rulesets and the classic protection
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
reads the CI status of the PR head itself.

- An `--all` pass is never a required-check
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
once.

`--expect` needs `--all` and is refused on every other operation.

It runs `gh pr checks <pr>` without `--required`, so it keeps the bound and
the exit-code rules above, and the states of the commit only make them stricter: exit 0 with no pending check listed is settled, exit 8 is pending, a
listed failing check is settled, and every other exit 1 is unresolved with
`status: "error"`. Exit 1 with no output and exactly `no checks reported on the
'<branch>' branch` is the exception, as in the required wait: no check has
reported yet, so the wait continues. At the bound with only that reply, `--all`
returns `timedOut: true` and an empty `checks`, which is never a pass. A
repository with no CI workflow therefore waits the full `--timeout` before it
returns, unless `noCheckSource` ends the wait, as stated below.

Every poll of both waits reads the PR merge state. When GitHub reports the PR as
conflicting, the wait returns at once with `"conflicting": true` and `"timedOut": false`.
Its `checks` list is empty, and `head` names the head that it read. That envelope is
never a pass. Dispatch a worker to merge the base branch, then run the wait again on the
new head. An `UNKNOWN` or null merge state, and a merge-state read that is failed, timed
out, or unparseable, keep the wait.

Exit 1 with `no required checks reported on the '<branch>' branch` stays
unresolved, because `--all` has no required-check answer. A `noRequiredChecks`
envelope never comes from `--all`. Use `--all` only after `noRequiredChecks`
or after the refusal above that no source states the required checks. A
`--compare-head` run takes the same path, so it runs `--all` after that refusal.
When the required wait reads a required check, it stays the one to run. `--all` is
refused on every other role operation, and so is `--head`. `--all` takes `--head`
as the required wait does.

The `--all` wait holds a pass while a `pull_request` workflow of the base branch can run for the PR. It holds while a `github-actions` check suite on the head is not completed. It also holds while the head has no `github-actions` suite. A dependent job of that workflow then needs no `--expect`.

The hold skips a workflow only when its text proves that no run starts for the PR. One proof is enough. The text names no `pull_request` trigger, or a `paths` list matches no PR file. A `paths-ignore` list can match every PR file, or a `branches` list can omit the base branch. A `branches-ignore` list can name the base branch.

A `types` filter never skips. A trigger or filter form that the command cannot settle holds the pass. So does a workflow file that the PR changes. So does a read that fails or cannot be parsed. The hold ends at the bound with `timedOut: true`, never a pass.

A PR head or base branch that moves during the reads holds the pass. A failing check still settles the wait. The suite read is pinned to the head SHA, like the check-run and status reads. Only a `github-actions` suite holds the pass, so a suite of another app never holds it. `--expect` stays needed for a check of a third-party app.

The hold covers no workflow that runs only on `push`. That workflow never holds the pass, whatever its `branches` or `paths` filters say. `--expect` stays needed for its check.

The command reads the files of the PR and the workflow files of the base branch. It reads them once per head, as for `noCheckSource` below, and you read none of them. A `pull_request` trigger with no filter holds, whether it is a bare key, an empty map, a string, or a list entry.

A `branches` list that names the base branch, a `branches-ignore` list that omits it, a `paths-ignore` list that leaves a PR file uncovered, and any `types` list hold. A pattern is settled only when it holds letters, digits, `_`, `.`, `-`, `@`, `/`, and `*`, so a `!`, `?`, `+`, or `[...]` pattern holds. A text with a syntax error, a second document, a tag, an anchor, or an alias holds. A failed read holds the pass and the next poll reads again.

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
  directory.
  - A file that names a trigger is passed over only when the
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
above.

A list at its API cap (3,000 PR files, 1,000 workflow files) is incomplete, and
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
elapsed, is not a finish condition (issue #319). The `--require-ci` gate refuses a finish
while a required check is pending, so a finish summary cannot carry it. Wait
again, dispatch the reviewer again, or `abort` with the pending check named in
the reason.

## Command detail

`head` names the commit that `checks` describe. `gh pr checks` queries by PR identity and names no commit, so the wait never takes a check state from it. Each poll reads the PR head `<sha>` and the base branch with `gh pr view <pr> --json headRefOid,baseRefName`, runs `gh pr checks` for its exit-code outcome, and reads every state from the check runs and commit statuses of `<sha>` by SHA (`repos/<slug>/commits/<sha>/check-runs` and `.../status`, every page, read together). The required wait judges each required context as the `--require-ci` gate does, with the gate's own matching and verdict: the contexts come from `requiredContexts` (repository rulesets with `integration_id`, classic protection with `app_id`, and the names `gh pr checks --required` lists), an app-qualified context is satisfied only by a check run of that app, the latest matching entry decides, and a context with no entry on `<sha>` is pending. The `--all` wait judges the latest check run of each name and app and the latest commit status of each context.

Each poll also reads the merge state with `gh pr view <pr> --json mergeable,mergeStateStatus`. A failed or unparseable merge-state read keeps the wait. A `CONFLICTING` mergeable value or a `DIRTY` merge state ends it with `"conflicting": true`.

A head that moves away and back, or a stale view, therefore cannot put another commit's checks under `head`. The states of `<sha>` only make the outcome stricter: a failing state of `<sha>` settles the wait, and a pass needs both the `gh pr checks` outcome and every state of `<sha>` to pass, so exit 8 or the no-check-yet reply keeps the wait running while `<sha>` shows a pass, until the bound ends it with `timedOut: true`. A failure that `gh pr checks` lists settles the wait whatever `<sha>` shows, and it is reported in `prFailures`, apart from `checks`, because it is PR-level evidence that is not pinned to `<sha>`: `checks` holds only states read for `head`, and a parent never records a pass from an envelope that carries `prFailures`. `prFailures` appears only when `gh pr checks` listed a failure in the last poll, and it survives a bound that a later read reaches and a commit or source read that fails (`head: null`, empty `checks`).

The required wait refuses a context it cannot resolve, with the rule of the supplied status (`requiredResolutionRefusal`): a ruleset or protection source that cannot be read, a source reply that cannot be parsed, and a failed read of the required names each exit 1 with `status: "error"` before any state is judged, because such a source can hold a required check or an app qualifier that the wait never saw; a listed failure still settles the wait then, and the `--all` wait reads no source. A commit read that fails, or that returns a reply the wait fails to parse or order, is an error too, with one exception.

The reads page and retry as [Waiting for required checks](../orchestrator/waiting-for-checks.md) states: no read follows a reply-supplied `Link` URL (#1033), a 500, 502, 503, or 504 is retried on the next poll inside the bound (#1025, #1121, #1125), and the `--require-ci` finish gate keeps failing closed on every read failure. A 5xx is retried only when its body is empty, JSON, or truncated JSON (#1519). A successful paged read joins the pages into the array that the earlier slurped read printed.

A transport failure with no HTTP status is retried on the next poll inside the bound (#1312). The classification accepts the bare `EOF` of a quoted URL at the end of the text. A status line, a 4xx, a foreign-host `Link` refusal, a reply body, and an unknown text stay terminal.

`--head <sha>` takes a full lowercase commit SHA of 40 or 64 hex digits, refuses an abbreviation, and is refused on every other operation: while the PR head is another commit the wait reads no checks and continues, and a wait that reaches the bound first returns `timedOut: true`, `head: null`, and an empty `checks`, never a pass. `head` is `null` only when no read completed (issue #961). It reads status only, so it writes no run state and needs no init, and it returns inside its own bound: `--timeout` is in seconds, defaults to 300, and refuses 0. The runtime owns the bound because `gh pr checks --watch` takes no timeout and a shell `timeout` is absent on Windows and on macOS without GNU coreutils (issue #329). The bound covers the whole command, not only the reads: it starts at command entry and no step of the command adds time to it.

Work-tree validation runs inside the bound, with `assertGitWorkTree` carrying the remaining time to `execa` as `timeout` with `cleanup` and `killDescendants`, so a slow or hung `git` is terminated and a validation that reaches the bound refuses, because a work tree the probe never confirmed is not one the command may read. Every read is limited to the time the command has left, and a read that reaches the limit is stopped and then given five seconds to exit, so the total bound is `--timeout` plus five seconds. The `gh` child is terminated on expiry the same way: `SIGTERM` then `SIGKILL` after one second on macOS, and `taskkill /T /F` over the process tree on Windows. `timedOut: true` means the bound was reached, whether with a pending check or during a read; it is a completed read, and the envelope carries the last check states that were read, so an empty `checks` with `timedOut: true` means no check state was ever read. `childExitUnconfirmed: true` appears only when the five-second ceiling expired with the `gh` child still unaccounted for: the command does not claim an exit it did not observe, and a parent that sees it settles the outstanding `gh` process before starting another wait.

The `gh pr checks` exit codes decide the outcome as the reviewer read states them: exit 0 with no pending check listed is settled, exit 8 is pending, and exit 1 is settled only when the output lists a failing required check, or when `gh` prints exactly `no required checks reported on the '<branch>' branch` and no output. Any other exit 1, and any output that is not a check list, exits 1 with `status: "error"` and no check state, so an unresolved read never reads as a pass. Every check item is read as a name plus a `state` or `bucket` the CLI knows; an item carrying no readable state is unresolved, so one item the CLI cannot read cannot settle the wait as a pass. A check that has not started is absent from `checks`, because the command omits it, so an empty list means no required check has reported and the wait continues. That answer, matched with the pattern of the required-check gate, and only when the ruleset and classic-protection sources each state the absence as the gate decides it, exits 0 with `"noRequiredChecks": true`, an empty `checks`, and `"timedOut": false`: it is not a read error and never a pass, and the parent dispatches the reviewer, which reads the CI status itself (issue #894), after one `wait-checks --all` run.

The same `--all` run follows the required wait's refusal that no required-check source can state the required checks (the Free-plan 403 of #301, a source that `settled nothing`, `could not be read`, or `did not state that it holds no required check`): it is never a required-check pass, and a reply that could not be parsed or a failed read of the required names stays an unresolved read with no `--all` run (issue #1018). Measured live on 2026-10-17 (Windows 11 Pro 10.0.26220, `gh` 2.102.0, Node v26.8.1) on a pull request of a private GitHub Free organization repository with no required check: the required wait exited 0 with `{"status":"ok","pr":265,"timedOut":false,"noRequiredChecks":true,"checks":[]}`, and the following `--all` wait exited 0 with `{"status":"ok","pr":265,"timedOut":false,"checks":[{"name":"checks","state":"SUCCESS","bucket":"pass"}]}`.

`--all` runs `gh pr checks <pr> --json name,state,bucket` with no `--required` for the same exit-code rules, and judges the check runs and commit statuses of the commit `head` names, with the same bound. Because it has no required-check answer, an exit 1 with no failing check listed is unresolved, including `no required checks reported on the '<branch>' branch`, and `noRequiredChecks` never appears in its envelope (issue #896). The one exception is the exact `no checks reported on the '<branch>' branch` reply with no output: it is an empty list, so the `--all` wait continues as the required wait does, and at the bound it returns `timedOut: true` with an empty `checks`, never a pass. A repository with no CI workflow therefore waits the full `--timeout` (issue #950). `--all` is refused on every other operation.

The `--all` wait holds a pass while a `pull_request` workflow of the base branch can run for the PR. It holds while a `github-actions` check suite on the head is not completed. It also holds while the head has no `github-actions` suite. A dependent job of that workflow then needs no `--expect`.

The hold skips a workflow only when its text proves that no run starts for the PR. One proof is enough. The text names no `pull_request` trigger, or a `paths` list matches no PR file. A `paths-ignore` list can match every PR file, or a `branches` list can omit the base branch. A `branches-ignore` list can name the base branch.

A `types` filter never skips. A trigger or filter form that the command cannot settle holds the pass. So does a workflow file that the PR changes. So does a read that fails or cannot be parsed. The hold ends at the bound with `timedOut: true`, never a pass.

A PR head or base branch that moves during the reads holds the pass. A failing check still settles the wait. The suite read is pinned to the head SHA, like the check-run and status reads. Only a `github-actions` suite holds the pass, so a suite of another app never holds it. `--expect` stays needed for a check of a third-party app.

The hold covers no workflow that runs only on `push`. That workflow never holds the pass, whatever its `branches` or `paths` filters say. `--expect` stays needed for its check.

The check suites of `<sha>` come from a paged read by SHA. The hold ends only when every `github-actions` suite of `<sha>` is completed (issue #1518). The files of the PR and the workflow files of the base branch are read once per head. The read uses `contents/.github/workflows?ref=<base SHA>` with the reads of `noCheckSource`. `prWorkflowMayRun` judges each file.

A missing workflow directory (the exact 404 reply) holds no workflow, so no hold follows. A `pull_request` trigger with no filter holds, whether it is a bare key, an empty map, a string, or a list entry.

The filters combine, so one proof of exclusion is enough. `paths` and `branches` patterns match without case and may also match a path under the pattern, which only keeps the hold. `paths-ignore` and `branches-ignore` match exactly and with case. A pattern is settled only when it holds letters, digits, `_`, `.`, `-`, `@`, `/`, and `*`. A text with a syntax error, a second document, a tag, an anchor, or an alias holds, and so does a PR with no file. A failed read holds the pass, is not kept, and the next poll reads again.

The `--all` wait ends that wait at once with `noCheckSource: true`, `timedOut: false`, and an empty `checks` when its first read lists no check, no `--expect` name is set, the read of the PR head by SHA finds no check run and no commit status, and no source can report a check for the PR head: the PR changes no file under `.github/workflows/` (`pulls/<pr>/files`, every page, `previous_filename` included), no workflow file of the base branch (`contents/.github/workflows?ref=<base SHA>`, then each file) names `pull_request`, `pull_request_target`, `push`, `merge_group`, `workflow_run`, or `check_suite` in its text (a file that names them counts as unable to report only under the path-filter rule below), and neither the base head nor the head of the latest merged PR of that commit has a check run or a commit status. The merged PR comes from `commits/<base SHA>/pulls` (the pager of the commit reads): the entries merged into the base branch with the latest `merged_at`, whose head SHAs the probe reads like the base head. PRs that share the latest merge time are all read, so a check on any one keeps the wait and the list order never decides. A PR on that commit that is not merged or targets another branch is no evidence, and no merged PR adds no read. Every entry must be exact, or the wait stays: `merged_at` null or a real UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`), `base.ref` a valid Git branch name (the rules of `git check-ref-format --branch`, so a blank, padded, or `..` name keeps the wait), `head.sha` a lowercase full SHA (#1062).

The base branch resolves to one SHA first (`commits/<base>`), every base read uses it, and a base branch or PR head that moved by the end keeps the wait. A missing workflow directory (the exact `Not Found (HTTP 404)` reply) counts as no workflow. Each read is bounded by the wait. The PR files use the pager of the commit reads, and the single reads (`readOne`) share the validation of that pager (`readReply`): the `Link` host check of every reply (#1033), the first-line status, a 2xx status block, one JSON value, and the 5xx retry classification (#1025), and a success with a `Link` header is refused.

A missing workflow directory is only the exact 404 reply: a 404 status line, exactly `gh: Not Found (HTTP 404)`, a JSON body, and no `Link` target. A workflow file needs `type: file`, well-formed base64 whose bytes equal `size` and are valid UTF-8, and no backslash or control character in its text, because a YAML escape can spell an event name. A read that fails, cannot be parsed, has another shape, or is at an API cap (3,000 PR files, 1,000 directory entries) keeps the normal wait.

A workflow file that names a trigger still counts as unable to report for the PR when the whole file parses as exactly one YAML document with the `yaml` package (the only parser of the project, with `uniqueKeys` on and aliases off), with no error and no warning, and its top-level `on` map names only `pull_request` and `pull_request_target`, each with a non-empty `paths` list, and no PR file (`previous_filename` included) matches any pattern under the GitHub filter rules. A pattern is a string of letters, digits, `_`, `.`, `-`, `@`, `/`, and `*` with no empty, `.`, or `..` segment. `*` stays inside one path segment and `**` crosses segments and matches any character, a newline included; a pattern with no `*` also matches the files under it, and the match is case-insensitive, which can only keep the wait. The wait stays when the file names any other event (`push`, `workflow_dispatch`, and the rest), a PR event has no `paths` list or an empty one, the file uses `paths-ignore`, a pattern holds any other character (a `!` negation, `?`, `+`, `[...]`, so the matcher never needs those translations), the text has a syntax error anywhere (for example a later `jobs: [` or an unterminated `branches: [main`), a second document, a duplicate key, a tag on any node (`!!str` and `!!map` included), an anchor, an alias, a second `on` key, or any other parser warning, a PR file name is not a string or holds a control character, a line or paragraph separator, or a lone surrogate (GitHub documents no rule for such a name), or the file list is incomplete. The limit: the check is YAML syntax, not the schema of GitHub Actions, so a well-formed file that GitHub rejects for another reason still counts, and the `branches` and `types` filters of the event are ignored, which only keeps the wait (#1065).

The envelope is never a pass: the parent dispatches the reviewer, records the CI status as not verified, and reads no workflow itself. The limit is that the base head and one merged PR head are two commits (the latest merge time, ties included), so a provider that skipped both, that registers later, or that reports on a base head with no merged PR (a direct push) stays unseen (issues #1054, #1062).

`--expect <check name>` (repeatable, needs `--all`, refused on every other operation) keeps the `--all` wait running until each named check has a check run on `<sha>`. A name matches the name of a check run exactly: it is trimmed, case-sensitive, and any app qualifies, and a commit status of that name never matches. An empty name is refused and a repeated name is accepted. Commit statuses still count in the overall pass evaluation: a check that a third-party app registers after the first ones passed is otherwise absent, so an early pass is not evidence. A name that never registers ends the wait at the bound with `timedOut: true` and the name in `awaiting`, never a pass, and a failing check still settles the wait (issue #978).

## A required check that fails on a known flaky test

A required check can fail on a test that the diff does not reach. The parent never reruns a job, because the parent writes nothing to GitHub (issue #1303).

Dispatch one worker turn for a required check that fails on a known flaky test. The turn does all of these steps in order:

1. The worker turn must wait, with a bound, until the run completes.
2. The worker turn must read the failure, with `gh run view --log-failed`.
3. The worker turn must decide whether the diff reaches the failing test.
4. The worker turn must record a known flaky recurrence in #1067, as the rules of that issue state.
5. The worker turn must rerun only the failed jobs with `gh run rerun <run id> --failed`.

The wait comes first because of two `gh` limits. `gh run view --log-failed` has no log until the run completes. `gh run rerun` refuses while another job of the run is in progress.

If the diff reaches the failure, or no #1067 section matches it, the worker turn reruns nothing and reports the failure. If the run is still in progress at the bound, the worker turn reruns nothing and reports that.

After that worker turn, run `wait-checks` again for the same head before the reviewer turn. Never use `wait-checks` to wait for the rest of the run, because it settles on the first failing check.

## Headless loop waits

The headless `agent-loop` command runs its own orchestrator and renders its own wait
prompt ([ADR 0013](https://github.com/andromarces/agent-loops/blob/main/adr/0013-bound-the-headless-required-check-wait.md)). A `role` parent does not follow that prompt. It follows the wait
rules above, and it runs the wait itself.

The `--require-ci` finish gate is the only check read that enforces; the advisory status read of a named PR does not. The gate refuses a finish while a required check is pending. A reviewer dispatch corrects that refusal.
