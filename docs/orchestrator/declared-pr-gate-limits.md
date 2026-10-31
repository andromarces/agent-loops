# Declared PR runs and unreadable required-check sources

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before init with `--pr`, and when an init with `--pr` is refused because a required-check source settled nothing.

- A base branch with no required check does not refuse `--pr` when every
  required-check source stated that it holds none. The gate passes on the PR head,
  the clean reviewed tree, and the merge state, and the run records it, so a
  declared run on such a branch ends and never keeps the #286 gap. A base branch
  whose required checks this credential cannot read still refuses every finish,
  because the gate cannot establish the absence, and the refusal names the source
  it could not read.
- Omit `--pr` when the repository rulesets of the PR base branch are unreadable to
  the gate, for example a private repository on the GitHub Free plan (#301), because
  a declared run there refuses every finish and can end only through `abort`.
  Init with `--pr`, `role declare-pr`, and the headless start read the required-check
  sources of the PR base once. They refuse when the rulesets read settled nothing,
  before any state file is written or child spawns. A read that fails for another
  reason, such as a transport failure, warns and does not refuse. A `--continue-from`
  run that restored its PR makes no start read, because the earlier run read at the
  start of its own `--pr` run or before it declared a worker-opened PR, and its
  prompt states none. After a refusal, omit
  `--pr` and finish with `--compare-head <pr>`, which compares the PR head with
  `reviewed.head` in the runtime and requires the PR to be open. Use the `"unresolvedCompare": true` marker only
  when the PR head itself cannot be read. The headless `--require-ci` with no
  `--pr` declares nothing, so the start does not read it and its gate refuses at
  finish.
