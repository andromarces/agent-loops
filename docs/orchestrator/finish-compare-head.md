# Finish with --compare-head

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you finish with `--compare-head <pr>`, and when a finish with it is refused.

`--compare-head <pr>` makes the PR-head half of the gate and nothing else, for a
repository whose required-check sources are unreadable, for example a private
repository on the GitHub Free plan (#301, #1098):

```bash
printf '%s' '{"changed":"...","verified":"...","deferred":"...","notDone":"...","open":"..."}'   | agent-loop role finish --cwd "<work tree>" --compare-head <pr>
```

The runtime reads the PR head and state and refuses the finish unless the PR is open,
its head equals `reviewed.head`, and the reviewed tree is clean. A closed or merged PR
refuses even when its head is unchanged. The one `gh pr view` also returns the
merge state, which the runtime does not evaluate. It reads no required-check
source or check result and claims none, so `verified` still states what
the checks showed. The envelope then carries `"headCompare": "verified"` and the
state file records the same field beside `summary`. That record differs from
`unresolvedCompare`, which says no one resolved the head. The flag is refused
together with `--require-ci` and with `unresolvedCompare`, and a run that
declares its PR still needs its `--require-ci` gate. Dispatch the reviewer again
when the PR head moved, then repeat the finish.
