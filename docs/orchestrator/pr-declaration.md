# Declaring a PR run

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you pass `--pr`, when a declared run refuses a finish, when the PR does not exist at init, or when a headless run declares its PR itself.

### A run declared with `--pr` at init

`--pr <pr>` on the init call declares that this run's work is delivered on that
pull request. The declaration is the run's PR input, so such a run can only end
through the gate: `agent-loop role finish --require-ci <pr>` here, and
`agent-loop --require-ci <pr>` in the headless loop, with the same PR number.

- A `finish` with no `--require-ci` is refused, and a `finish` whose
  `--require-ci` names another PR is refused without reading GitHub. That refusal
  is the only way the interactive path can catch a wrong number, because its
  `--require-ci` arrives at `finish`. The headless path takes both flags on one
  command line, so `agent-loop --pr 42 --require-ci 7` is a usage error before the
  run starts.
- A `finish` that sets `"unresolvedCompare": true` is refused, because the gate
  resolves that compare. The recorded marker is the accepted gap of a run that
  declares no PR, and a declared run does not have it. One refusal names every
  condition the finish broke above the `--require-ci` gate, so read all of it
  rather than the first reason. The interactive `finish` reads the gate only
  after those conditions pass, so a later `finish` can report a `--require-ci`
  condition that the first refusal did not name. A matching gate applies its own
  conditions on top of the declaration, and a gate for another PR is never read.
- The gate flag is a run input, so no `dispatch` supplies it and a repeat
  `finish` is refused the same way. A declared run with no gate can only end
  through `abort` with the missing gate named in the reason.
- `--pr` is an init field, so a later call that changes it is refused like any
  other init field. The one exception is `role declare-pr`, below. A state file
  written before this field has no `pr`, and that run keeps the marker-only
  behavior.
- `review-only` refuses `--pr` at init, because that mode rejects `--require-ci`
  at finish and the run would refuse every finish. On the headless path every
  flag arrives on one command line, so `--mode review-only` with `--pr`,
  `--require-accept`, or `--require-ci` is a usage error before the run starts,
  with the same two wordings this section states.
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
  before any state file is written or child spawns.
  - A read that fails for another
    reason, such as a transport failure, warns and does not refuse. A `--continue-from`
    run that restored its PR makes no start read, because the earlier run read at the
    start of its own `--pr` run or before it declared a worker-opened PR, and its
    prompt states none. After a refusal, omit
    `--pr` and finish with `--compare-head <pr>`, which compares the PR head with
    `reviewed.head` in the runtime and requires the PR to be open.
  - Use the `"unresolvedCompare": true` marker only
    when the PR head itself cannot be read. The headless `--require-ci` with no
    `--pr` declares nothing, so the start does not read it and its gate refuses at
    finish.

A run that declares no PR keeps the accepted gap: the runtime has no PR input, so
an omitted marker still reads as a verified finish. The declaration closes the
gap for a run that states its PR (issue #302). A headless run that takes neither
`--pr` nor `--require-ci` can also gain its PR from the runtime, as the next
section states.

The conditions that the `--require-accept` and `--require-ci` gates check at `finish` are in
[Finish gates](finish-gates.md).

### A headless task whose worker opens the PR

A headless run with neither `--pr` nor `--require-ci` has no PR input at start.
After each worker turn that ends `ok`, the runtime looks for the PR that the
worker opened. It declares that PR once, and the run then behaves as one that
passed `--pr` and `--require-ci` for that PR (ADR 0043, ADR 0045).

- The runtime reads Git and GitHub state only. It reads the checked-out branch
  and the URL of the branch remote. It reads the work tree head that it read
  after the turn. It reads `gh pr list --head <branch> --state open`. A worker report, a task text, and an orchestrator
  action never choose or change the PR.
- The runtime declares the PR only when one open PR comes from that branch. Its
  base repository must be the repository of the branch remote. Its URL must end
  in its number. Its head commit must equal the work tree head.
- The work tree head must equal that head before and after the `gh` read. The
  branch and the remote repository must be unchanged by the read. A change
  leaves the run undeclared.
- The branch remote is `branch.<branch>.remote`, or `origin` when none is set.
  The PR URL gives the base repository, because `GH_REPO` can redirect `gh`.
- These states leave the run undeclared: no match, several matches, a PR from a
  fork, a PR for another base repository, and a detached head. A head that
  differs from the turn head does the same. So does a branch or remote that
  changes during the read. A failed `gh` read, an unparseable reply, and any
  malformed entry also leave the run undeclared.
- The runtime logs a warning for each of those states except no match. The next
  worker turn tries again.
- A declaration emits one `pr-declared` event with `pr` and `stepsUsed`. The
  result prompt of that worker turn carries `declaredPr` and states the finish
  rule. Every later reviewer prompt carries the required-check status for that PR.
- The declaration is one way and happens once. A run with `--pr` or
  `--require-ci` at start never resolves a PR. No later turn changes the PR.
- The runtime applies the `--require-ci` gate to the PR that it declared, as if
  the run had passed `--require-ci <pr>` (ADR 0045). A finish passes only after
  a reviewer turn on the current state, with the PR head equal to the reviewed
  commit, a clean reviewed tree, a merge state the gate accepts, and every
  required check passed. A finish is refused while a required check fails or is
  pending, and a refusal names the check. A finish with `unresolvedCompare` is
  refused, because the gate resolves that compare. The missing-gate refusal and
  the abort-only outcome apply only to `--pr` with no `--require-ci`.
- `--continue-from` keeps a declared PR. The continued run restores it from the
  `pr-declared` events of the earlier transcript. It emits a `pr-declared` event
  with `restored: true` for every continuation of a declared run, whatever flags
  it passes. A later continuation of that transcript keeps the PR.
- The declared PR is an init field of the continued run. `--pr` or `--require-ci`
  for another PR is refused before any turn. A flag for the same PR is accepted.
- A continuation refuses `--mode review-only` for a declared PR. It also refuses
  a malformed `pr-declared` record, such as a `pr` that is not a positive integer.
- A continued run applies the same gate to the restored PR. A `--pr` for that PR
  adds no refusal, because the PR was declared by the runtime.
- Before the runtime declares the PR, it reads the required-check sources of the
  PR base once, as the start of a `--pr` run does (#1092). When the rulesets read
  settles nothing, such as the Free-plan 403 (#301), the run stays undeclared and the
  runtime logs a warning that names the reason. The runtime then records the PR in
  a `pr-undeclared` transcript event and compares its head at finish, as
  `--compare-head` does (#1111, [ADR 0053](../../adr/0053-compare-the-head-of-a-worker-opened-pr-that-the-runtime-refused-to-declare.md)): see the headless compare
  below. A finish with `unresolvedCompare` is refused, because the compare resolves
  that head. A read that fails for another reason, such as a transport failure, warns
  and still declares the PR (#1097).
- A continued run that restored its PR reads no required-check source at start,
  because the earlier run read at the start of its own `--pr` run or before it
  declared a worker-opened PR (#1092, #1097). Its orchestrator prompt states no
  start read. A continuation that declares a new PR makes the read.
- A repository whose required-check sources are unreadable refuses `--pr <n>` and
  `--require-ci <n>` at start or at finish, so a headless run for an existing PR there
  passes `--compare-head <n>` (#1104). At finish, the runtime reads the PR head of
  `<n>`, refuses unless the PR is open, it equals the reviewed head, and the reviewed tree is clean,
  reads no required-check source, and claims no check result. A pass emits a
  `head-compare` transcript event and the run exits `0`, where
  `unresolvedCompare` exits `4`. The flag is refused with `--pr`, `--require-ci`,
  and `--mode review-only` before the run starts, with a continuation of a declared
  PR, which is refused before any transcript write or turn. A finish that also sets
  `unresolvedCompare` is refused before any GitHub read. The transcript records the
  flag, but a continuation does not restore it: each invocation selects the flag
  again, as it selects `--require-ci`, and omitting it on a continuation disables
  the runtime compare and leaves the marker path.
  - The runtime declares no worker-opened
    PR in such a run. The flag names a PR that exists at start.
- A PR that the worker opens on such a repository needs no flag (#1111). The runtime
  refuses to declare it, records it in a `pr-undeclared` event with `pr` and
  `stepsUsed`, and applies the same compare at finish with no operator choice: a
  verified compare when the PR is open, its head equals the reviewed head, and the
  reviewed tree is clean, a refused finish when the heads differ or the PR is closed
  or merged. A pass emits `head-compare` and
  the run exits `0`. A run with `--pr`, `--require-ci`, or `--compare-head` never
  records one. A later worker turn that declares a PR clears the undeclared PR, and
  one that refuses another PR replaces it. A PR that leaves the open list keeps
  its place, and the compare refuses it as closed or merged.
  - A continuation does not restore the
    undeclared PR: it restores a PR from a `pr-declared` record only, so the
    continuation resolves the worker-opened PR again after its own worker turn, and a
    continuation with no worker turn keeps the marker path.
- To gate a PR that exists at start, pass `--require-ci <n>`. Or use
  `agent-loop role` with `role declare-pr`, which takes the gate at `finish`.

### A task whose worker opens the PR

The PR does not exist at init when the task is "address issue N through a PR", and
the parent cannot open it, because the role rules forbid a parent write to
GitHub. Declare the PR after the worker opens it:

1. Init the run with no `--pr`, and dispatch the worker.
2. Read the PR number from the worker report.
3. Run `agent-loop role declare-pr --cwd <dir> --parent-session <id> --pr <n>`.
   The envelope is `{"status": "ok", "lifecycle": "active", "pr": <n>}`.
4. From then on, the run is a declared run: every reviewer prompt carries the
   required-check status, the [Waiting for required checks](waiting-for-checks.md) rules apply, and
   `finish` must end through `--require-ci <n>`.

- The transition is one way, from no PR to a number. `declare-pr` refuses a run
  that already has a PR, whether set at init or by an earlier `declare-pr`, and
  refuses a terminal run. It works from `active`, `dispatched`, and
  `interrupted`, and leaves the lifecycle as it is.
- `declare-pr` refuses `review-only`, as init refuses `--pr` there.
- `declare-pr` is a parent operation. A child role never runs it: the spawn-time
  marker refuses it, as it refuses `extend`, `finish`, and `abort`. It requires
  `--parent-session` with the stored id, and the id check has the limits that the
  `extend` rules state.
- The headless loop has no `declare-pr`, because the orchestrator is a child turn
  and never chooses the PR. The runtime resolves it instead, as the next
  section states.
- Declare the PR before the first reviewer turn that follows the worker turn, so
  that turn already carries the status. A reviewer turn that ran earlier read the
  checks itself.
- A repository whose rulesets the gate does not get (#301) refuses every finish
  of a declared run, so do not declare the PR there. `declare-pr` reads the
  required-check sources once and refuses there, leaving the run unchanged. A read
  that fails for another reason warns and does not refuse. The recovery, the
  `headCompare` record, and the marker-only case are in the section above.
  - Run
    `wait-checks --all` once before each reviewer turn, because the required wait
    refuses there. [Waiting for required checks](waiting-for-checks.md) states that wait and the `noCheckSource`
    envelope that ends it at once.
