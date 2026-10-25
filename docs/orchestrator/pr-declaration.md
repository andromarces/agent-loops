# Declaring the PR when a worker opens it

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this when the PR does not exist at init, or when a headless run declares its PR itself.

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
  runtime logs a warning that names the reason. The run then keeps the
  `unresolvedCompare` marker path: compare the PR head with the reviewed commit, and
  finish with the marker. A read that fails for another reason, such as a transport
  failure, warns and still declares the PR (#1097).
- A continued run that restored its PR reads no required-check source at start,
  because the earlier run read at the start of its own `--pr` run or before it
  declared a worker-opened PR (#1092, #1097). Its orchestrator prompt states no
  start read. A continuation that declares a new PR makes the read.
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
- A repository whose rulesets the gate does not get (#301), for example a private
  GitHub Free-plan organization repository, refuses every finish of a declared
  run, so such a run can only end through `abort`. `declare-pr` reads the
  required-check sources once and refuses there, leaving the run unchanged. A read
  that fails for another reason warns and does not refuse. Do not declare the PR
  there. Finish with the `unresolvedCompare` marker
  after you compare the PR head with `reviewed.head` yourself, and run
  `wait-checks --all` once before each reviewer turn, because the required wait
  refuses there. [Waiting for required checks](waiting-for-checks.md) states that wait and the `noCheckSource`
  envelope that ends it at once.
