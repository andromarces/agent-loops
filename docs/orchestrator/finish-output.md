# Finish output

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you call `finish`, when you need the exact summary shape or the `unresolvedCompare` marker, or when a `finish` is refused.

## Completion in `review-only`

The gate is on the turn, not on a report: a turn that ended in an error satisfies
it, so the finish can carry no report. The runtime checks that all five
required summary keys are non-empty strings. An optional `notes` key is also
accepted. It refuses a finish that holds any other
key and names each unknown key. The `role finish`
stdin object allows the six summary keys and an optional boolean
`unresolvedCompare`. It never compares the summary content with what the
reviewer returned.

A `review-only` finish needs a reviewer turn that ran, whatever it returned. The
runtime does not compare the summary with the reviewer result. Record the
reviewer status and verdict in `verified`, including an error or a missing
report.

- `agent-loop role finish` applies no reviewer-turn rule of its own.
- Neither path takes `--require-accept` in this mode. `role finish` refuses the
  flag at `finish`, and the headless command refuses it before the run starts.
  Both give this error:
  `--require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.`

Record what the run did not cover in `notDone` and `open`.

## Summary shape

`finish` reads the summary as JSON on stdin and is accepted only from the
`active` lifecycle. The five base keys are required, and an optional `notes`
key carries reviewer notes. The keys match the orchestrator action contract
(`validateAction`):

```bash
printf '%s' '{"changed":"...","verified":"...","deferred":"...","notDone":"...","open":"..."}' \
  | agent-loop role finish --cwd "<work tree>"
```

A finish that records an unresolved PR-head compare instead of aborting sets
`"unresolvedCompare": true` beside the summary keys:

```bash
printf '%s' '{"changed":"...","verified":"not verified: PR head unresolved","deferred":"...","notDone":"PR head unresolved","open":"PR head unresolved","unresolvedCompare":true}' \
  | agent-loop role finish --cwd "<work tree>"
```

The value must be a boolean, and the key is not one of the six summary keys:
`summary` keeps only those keys. A refused finish keeps the lifecycle,
`active` or `interrupted`. The stdin object allows only the six
summary keys and `unresolvedCompare`. A finish with any other key is refused and the
refusal names each unknown key; resend the finish with only the allowed keys.

The envelope then carries
`"unresolvedCompare": true` and the state file records the same field beside
`summary`. A finish with the
field absent, or set to `false`, is a verified finish. The marker cannot be
combined with `--require-ci`. A run that cannot use `--require-ci`, for example one whose base branch requires a check this credential cannot read,
finishes with `--compare-head <pr>`, or records the marker when it cannot
read the PR head. A base branch whose required-check sources each state that it
holds no required check can use the gate.

A run that cannot use `--require-ci` finishes with `--compare-head <pr>`, for a repository
whose required-check sources are unreadable. The runtime reads the PR head and
state and refuses the finish unless the PR is open, its head equals `reviewed.head`, and the
reviewed tree is clean. A closed or merged PR refuses even when its head is unchanged.

The required wait before that finish, and the `--all` wait when no source can
state the required checks, are in
[Finish with --compare-head](finish-compare-head.md).

The runtime
reads no required-check source or check result and claims none, so `verified` still states what
the checks showed. A finish that also sets `unresolvedCompare` is refused. Dispatch the reviewer again when the PR head moved, then repeat the finish. The
command and the `headCompare` record are in
[Finish with --compare-head](finish-compare-head.md).

A run that can use the gate finishes with `agent-loop role finish --require-ci <pr>`.

The conditions that the `--require-accept` and `--require-ci` gates check at
`finish` are in [Finish gates](finish-gates.md).
