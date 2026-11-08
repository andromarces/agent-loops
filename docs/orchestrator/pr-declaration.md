# Declaring a PR run

Part of the [orchestrator instructions](../orchestrator-instructions.md). Read this before you pass `--pr`, when a declared run refuses a finish, or when the PR does not exist at init.

### A run declared with `--pr` at init

`--pr <pr>` on the init call declares that this run's work is delivered on that
pull request. The declaration is the run's PR input, so such a run can only end
through the gate: `agent-loop role finish --require-ci <pr>`, with the same PR number.

- A `finish` with no `--require-ci` is refused, and a `finish` whose
  `--require-ci` names another PR is refused without reading GitHub.
- A `finish` that sets `"unresolvedCompare": true` is refused. A declared run
  does not have the marker. One refusal names every
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
- `review-only` refuses `--pr` at init.
- A base branch with no required check does not refuse `--pr` when every
  required-check source stated that it holds none. A base branch
  whose required checks this credential cannot read still refuses every finish, and
  the refusal names the source it could not read.
- Omit `--pr` when the repository rulesets of the PR base branch are unreadable to
  the gate, for example a private repository on the GitHub Free plan: a declared
  run there refuses every finish and can end only through `abort`.
  Init with `--pr` and `role declare-pr` read the required-check
  sources of the PR base once. They refuse when the rulesets read settled nothing,
  before any state file is written or child spawns.
  - A read that fails for another
    reason, such as a transport failure, warns and does not refuse. After a refusal, omit
    `--pr` and finish with `--compare-head <pr>`, which compares the PR head with
    `reviewed.head` in the runtime and requires the PR to be open.
  - Use the `"unresolvedCompare": true` marker only
    when the PR head itself cannot be read.

The conditions that the `--require-accept` and `--require-ci` gates check at `finish` are in
[Finish gates](finish-gates.md).

### A task whose worker opens the PR

The PR does not exist at init when the task is "address issue N through a PR".
Declare the PR after the worker opens it:

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
  marker refuses it, as it refuses `extend`, `refresh-local`, `set-model`, `finish`, and `abort`. It requires
  `--parent-session` with the stored id, and the id check has the limits that the
  `extend` rules state.
- Declare the PR before the first reviewer turn that follows the worker turn. A reviewer turn that ran earlier read the
  checks itself.
- A repository whose rulesets the gate does not get refuses every finish
  of a declared run, so do not declare the PR there. `declare-pr` reads the
  required-check sources once and refuses there, leaving the run unchanged. A read
  that fails for another reason warns and does not refuse. The recovery and the
  marker-only case are in the section above; the `headCompare` record is in
  [Finish with --compare-head](finish-compare-head.md).
  - Run
    `wait-checks --all` once before each reviewer turn. [Waiting for required checks](waiting-for-checks.md) states that wait and the `noCheckSource`
    envelope that ends it at once.
