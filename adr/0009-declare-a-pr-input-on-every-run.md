# 0009. Declare a PR input on every run that is PR work

## Status

accepted

## Date

2026-09-28

## Context

`--require-ci <pr>` resolves the PR head in the runtime on both paths, so a
gated run no longer depends on a field the parent set (#293). The gate stayed
opt-in, though, and the `unresolvedCompare` marker stayed the only machine
record of an unresolved compare in every other run. The `known-limit` note
beside the field in `src/contracts/orchestrator-action.mjs` was scoped to a run
that takes no PR input and named the remaining upgrade path:

> Ceiling: one finish that claims a compare nothing verified, per ungated run.
> Upgrade path: require a PR input on every run.

Two gaps remained inside that ceiling:

- A parent can forget `--require-ci` on a run whose task names a PR number, and
  nothing catches it, because the runtime has no PR input to compare against.
- A parent can set `unresolvedCompare` under `notDone` and `open` and omit the
  marker, and the result reads exactly like a verified finish: loop exit 0, no
  `unresolved-compare` event, and the same for the interactive envelope and
  state file (issue #286).

Detecting either needs to know the run is PR work. The task text names a PR
number, but parsing it is a guess about prose, and a wrong guess is a wrong
refusal.

## Decision

1. `--pr <pr>` is a new run-level input that declares the run PR work on that
   pull request. It is read on the headless `agent-loop` path and on the
   `agent-loop role` init call, and it is a positive integer, read by the same
   `readPositiveInt` that reads `--require-ci` and `--max-steps`.
2. A run that declares a PR must end through the `--require-ci <pr>` gate for
   that same PR. A finish with no gate, or with a gate naming another PR, is
   refused. The gate is never read for another PR, so a wrong number costs no
   GitHub call.
3. A declared run also refuses a finish that sets `unresolvedCompare`, because
   the gate it requires resolves that compare. The refusal wording comes from one
   shared function, so a gated run keeps the existing `--require-ci` wording and
   a declared run without a gate names the gate it must reach instead. The
   wording is now one function on both paths rather than an exported constant,
   because `unresolvedCompareReason` is what both paths call.
4. Every applicable refusal is collected and reported in one refusal, in the
   order marker condition, `--require-accept`, declared-PR gate condition,
   `--require-ci`. The interactive `role finish` applies the same rule and the
   same order, so a finish that breaks two rules names both on either path and a
   parent learns every condition from one call. An undeclared run keeps the error
   text it had before, so the collect-then-report rule changes only the runs that
   declare a PR.
5. The prompt states one rule and predicts no outcome: a declared run finishes
   through the gate for the declared PR; a finish with no gate, a gate for
   another PR, or the unresolved-compare marker is refused; a gate for another PR
   is not read; a matching gate still applies its own conditions; and one refusal
   names every condition that failed. The runtime collects every applicable
   condition, so a per-case line that named the sole reason, or described a gate
   the runtime never evaluates, would contradict it. The block is empty without
   `--pr`, so an undeclared run keeps the prompt it had.
6. The `--require-ci` gate runs only when nothing above it refused on the
   interactive path, so a refused `finish` never reads GitHub. The headless loop
   evaluates every gate it owns, as it did before, because it can report all of
   them and a `gh` failure is already a refusal there.
7. The gate flag is a run input, so no child turn can supply it. That refusal
   therefore needs no child turn, and its recovery names `abort` with the
   missing gate as the only outcome the orchestrator owns. The refusal prompt
   gets its own ending text, because the marker ending would tell the
   orchestrator to re-finish without a marker it does not carry.
8. The interactive path applies the same rule at `finish`, reading the declared
   PR from the state file. `--pr` is an init field, so a later call that changes
   it is refused like `--task` or `--mode`. A state file written before this
   field has no `pr` and keeps the marker-only behavior.
9. `review-only` refuses `--pr` at init. That mode rejects `--require-ci` at
   finish, so a declared run there would refuse every finish and could never
   end. The refusal moves to init, where the parent can still correct it.
10. A run that declares no PR behaves exactly as before: the marker is recorded,
    the exit code is `UNRESOLVED_COMPARE_EXIT` for a recorded compare, and a
    finish that omits the marker still reads as a verified one.
11. The headless orchestrator prompt states the declaration and the gate it
    requires, so the orchestrator knows a declared run cannot finish without the
    gate and cannot record the marker.

## Consequences

- A run that states its PR cannot end through a field the parent set, so a
  forgotten `--require-ci` is a refusal instead of a silent verified finish.
- A finish that breaks two conditions now names both on either path, so a
  corrective turn or a `finish` call is not spent on the condition the next
  refusal would name.
- A parent must pass both flags on the headless path, and must init with `--pr`
  and finish with `--require-ci` on the interactive path. That is the price of
  the runtime knowing the run is PR work.
- `role finish` no longer returns only the first refusal. A refused `finish`
  that also carries `--require-ci` does not read GitHub, so a parent learns the
  local conditions in one call and reaches the gate only once they pass.
- A declared run with a base branch that has no required checks cannot be
  gated, because `checkCi` refuses an empty union of required checks. Such a
  run must not declare a PR, and the marker stays its only trace. The ceiling
  of `checkCi` is tracked in #295 and #301 and is not changed here.
- A run that declares no PR keeps the accepted gap of #286. The declaration
  narrows the gap to the runs that do not state their PR, and the runtime cannot
  detect a PR run that declares nothing.
- The state file gains one field. A state file written before this field reads
  as no declaration, so an in-flight interactive run is unaffected.

## Alternatives

1. **Require `--require-ci <pr>` whenever the task text names a PR number**:
   needs no new flag, but the runtime would parse prose to decide whether the
   run is PR work. A task that mentions a PR for reference, or names one in an
   example, would be refused. Rejected; the declaration is explicit.
2. **Record the omission instead of requiring the input**: have the runtime
   detect a run that never received a PR input while the work was delivered on a
   branch, and emit a signal comparable to `unresolved-compare`. This is the
   weaker option the issue names, and it matches the ceiling already documented.
   Rejected; the issue asks for the explicit declaration.
3. **Make `--pr` imply the gate**, so a run that declares a PR is gated without a
   second flag. Fewer flags, but the gate would then be unrefusable: a parent
   could not read the PR through a run of its own, and the declaration would no
   longer be a declaration. Rejected; the gate stays an independent opt-in that
   the declaration makes mandatory.
4. **Refuse a mismatched gate at parse time instead of at finish**: the two flags
   are on the same headless command line, so a mismatch is knowable before the
   run starts. Rejected for the shared path, because the interactive `finish`
   carries the gate on a later call than the init that carries the declaration,
   so a finish-time refusal is the one place both paths have the same inputs.

## Authors

Andro Marces

## Links

- [Issue #302: Require a PR input on every run so an omitted unresolvedCompare marker cannot read as verified](https://github.com/andromarces/agent-loops/issues/302)
- Implementation: `missingGateRefusal` in `src/runtime.mjs`, the finish gate in `src/role.mjs`, the `--pr` flag in `src/cli.mjs`, the prompt block in `src/prompts/orchestrator.mjs`; tests in `tests/runtime.test.mjs`, `tests/role.finish-abort.test.mjs`, `tests/role.init.test.mjs`, `tests/cli.test.mjs`, and `tests/prompts/orchestrator.test.mjs`; documented in `docs/orchestrator-instructions.md` and `README.md`
- [Issue #286: An omitted unresolvedCompare marker reads as a verified finish](https://github.com/andromarces/agent-loops/issues/286)
- [PR #293](https://github.com/andromarces/agent-loops/pull/293)
- [ADR Index](README.md)
