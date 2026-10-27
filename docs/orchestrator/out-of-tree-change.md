# A change outside the work tree

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init when the task changes state outside the work tree, and before you write a reviewer prompt for such a task. An example is a service configuration that a worker applies on a remote host over SSH, with no repository diff.

The runtime identity fields cover the work tree only. For such a task, `reviewed.head` is the unchanged base commit, `reviewed.clean` is true, and no field identifies the out-of-tree state. The `--require-accept` gate compares work tree snapshots, so it passes after any later change to the out-of-tree state.

- An accept is the reviewer report on the out-of-tree state at the time of that turn, not an identity that the runtime checks.
- Name the out-of-tree system and its read-only limits in the reviewer prompt, for example no service restart and no file write on the host. The runtime mutation check does not see a write to that system.
- State in `verified` of the finish summary that `reviewed` identifies no change, and name what the reviewer checked on the out-of-tree system.
- Before init, tell the operator that the reviewer turn keeps the credentials of the user for that system, unless the operator chooses a sandboxed mode with `--reviewer-sandbox` ([Codex reviewer sandbox mode](reviewer-sandbox.md)). A sandboxed mode probably cannot reach the system. A headless run has no such step: the operator chose the mode in the command.
