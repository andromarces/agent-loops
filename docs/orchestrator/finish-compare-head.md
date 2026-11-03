# Finish with --compare-head

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you finish with `--compare-head <pr>`, and when a finish with it is refused. The core rules of that finish are in [Finish output](../orchestrator-instructions.md#finish-output).

`--compare-head <pr>` makes the PR-head half of the gate and nothing else (#301, #1098):

```bash
printf '%s' '{"changed":"...","verified":"...","deferred":"...","notDone":"...","open":"..."}'   | agent-loop role finish --cwd "<work tree>" --compare-head <pr>
```

The one `gh pr view` also returns the merge state, which the runtime does not evaluate. The
envelope then carries `"headCompare": "verified"` and the state file records the same field beside
`summary`. That record differs from `unresolvedCompare`, which says no one resolved the head. The
flag is refused together with `--require-ci` and with `unresolvedCompare`, and a run that declares
its PR still needs its `--require-ci` gate.

Before a finish with `--compare-head`, run the required wait on the reviewed head first.
When that wait refuses because no source can state the required checks, run
`agent-loop role wait-checks --all` on the same head. A pending or failing check goes into
`notDone` or blocks the finish. The runtime reads no check result for that finish, so the
wait is the only check evidence.
