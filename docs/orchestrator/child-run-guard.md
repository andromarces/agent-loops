# Child run guard

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when a child role ran `extend`, `declare-pr`, `finish`, or `abort`, or when a call is refused for `AGENT_LOOP_SPAWNED_RUN`.

A child role never runs `extend`, `declare-pr`, `finish`, or `abort`. Each subcommand refuses a
caller whose `AGENT_LOOP_SPAWNED_RUN` list holds the key of the run it acts on. The
runtime sets the variable, as a comma-separated list of the keys of every
enclosing run and then the key of the dispatching run, in the environment of every worker and reviewer process, and in no other spawn. The key
is the name of the run's state directory, the hash each subcommand uses to find
the run state. A path spelled another way, such as a symlink alias, finds no
state. A child that names the work tree as the run does is refused even when the
work tree is gone. A
process keeps a marker it inherited. A parent session that another run's child
started holds a different key for its own work tree and is not refused. A worker
that a nested run starts holds the keys of the outer run and the nested run, so
it is refused against both. `extend` also refuses a call whose `--parent-session` is missing or differs from the run's stored parent
session id. The id check alone does not identify the caller, so a child that
clears its environment passes, and so does a harness that filters the variable
from shell commands. An orchestrator or parent that a child of the same
run started, in that run's work tree, inherits the key and is refused. The prompt
rule backs the marker.
