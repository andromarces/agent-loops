// Gate refusal messages shared by the headless and interactive finish gates and the CLI.
// One wording per refusal, shared by both paths, because the interactive path
// states these rules and the headless path must not drift from it (#337).
export const REVIEW_ONLY_PR_REFUSAL =
  "--pr declares PR work, which needs the --require-ci gate; review-only rejects that gate.";
export const REVIEW_ONLY_COMPARE_HEAD_REFUSAL =
  "--compare-head compares a PR head, and review-only has no PR work; review-only accepts a flagless finish.";
export const REVIEW_ONLY_GATE_REFUSAL =
  "--require-accept and --require-ci apply only to work-first and review-first; review-only accepts any verdict.";
// The review-only worker refusal, worded after the interactive `--role worker` guard it mirrors, so
// a parent reads one rule on both paths.
export const REVIEW_ONLY_WORKER_REFUSAL = "mode review-only rejects a run_worker action";

/**
 * The refusal of a declaration of a PR that the gate can never pass. `label` names the refused
 * input, for example `--pr 42`, and `reason` is the text of `unreadableGateReason`. `finish` is the
 * recovery clause that follows "omit --pr, then".
 * @param {string} label
 * @param {string} reason
 * @param {string} [finish]
 * @returns {string}
 */
export function unreadableGateRefusal(
  label,
  reason,
  finish = "finish with the unresolvedCompare marker after you compare the PR head with the reviewed commit yourself",
) {
  return `${label} is refused: ${reason}, so the --require-ci gate would refuse every finish of a declared run. Do not declare the PR: omit --pr, then ${finish}.`;
}

// The marker refusal a gated run gets, kept as a constant so the shared reason
// function cannot drift apart on the wording.
const UNRESOLVED_COMPARE_WITH_CI =
  "unresolvedCompare cannot be combined with --require-ci: the gate resolves the PR head, so that compare is not unresolved";

/**
 * The marker refusal for the run's PR input, or null when the run declares
 * neither a gate nor a PR. The marker stays the only record then. A declared
 * PR run needs the gate the same way a gated run does. It refuses the marker
 * too and names the gate it must reach, instead of a flag it never carried
 * (#302). The two paths share this function so the wording cannot drift.
 * @param {object} options
 * @returns {string | null}
 */
export function unresolvedCompareReason({ pr = null, requireCi = null }) {
  if (requireCi !== null) {
    return UNRESOLVED_COMPARE_WITH_CI;
  }
  if (pr !== null) {
    return `unresolvedCompare cannot be combined with a run that declares PR ${pr} (--pr): the run must end through the --require-ci ${pr} gate, which resolves that PR head, so that compare is not unresolved`;
  }
  return null;
}

/**
 * The refusal of the headless `--compare-head` beside `--pr` or `--require-ci`. Both declare or gate
 * a PR, so the run must end through the gate that reads the required checks and resolves the head.
 */
export const COMPARE_HEAD_INPUT_REFUSAL =
  "--compare-head cannot be combined with --pr or --require-ci: a run that declares or gates a PR ends through the --require-ci gate, which resolves the PR head and reads the required checks, so pass one of them";

/**
 * The refusal of `--compare-head` beside a flag or marker that already settles the PR head, or null.
 * `--require-ci` resolves the head in its gate, and `unresolvedCompare` records that no one did.
 * Either one with this verified compare records two outcomes for one head (#1098).
 * `flag` is false for the compare of a worker-opened PR that the runtime left undeclared (#1111).
 * No flag selected it, so the refusal names the compare and not the flag.
 * @param {{ requireCi: number | null, unresolvedCompare: boolean, flag?: boolean }} options
 * @returns {string | null}
 */
export function compareHeadConflict({ requireCi, unresolvedCompare, flag = true }) {
  if (requireCi !== null) {
    return "--compare-head cannot be combined with --require-ci: the gate resolves the PR head and reads the required checks, so pass one of them";
  }
  if (unresolvedCompare) {
    return `${flag ? "--compare-head" : "the head compare of the undeclared PR"} cannot be combined with unresolvedCompare: the compare either resolved the PR head or did not`;
  }
  return null;
}

/**
 * The refusal a `--pr <pr>` declaration gives when the run carries no gate for
 * that PR. The gate can be absent or name another pull request. A gate flag
 * is a run input, so no turn in the run can supply it, and the refusal ends the
 * run. The recovery names `abort` as the only outcome the orchestrator owns.
 * @param {number | null} pr the declared PR, or null when the run declares none
 * @param {number | null} requireCi the gate PR, or null when no gate was passed
 * @returns {{ reason: string, recovery: string } | null} null when the run declares no PR or gates it
 */
export function missingGateRefusal(pr, requireCi) {
  if (pr === null || requireCi === pr) {
    return null;
  }
  const state =
    requireCi === null
      ? "this run carries no --require-ci gate"
      : `this run gates PR ${requireCi} instead`;
  return {
    reason: `this run declares PR ${pr}, so a finish must end through the --require-ci ${pr} gate, and ${state}`,
    recovery: `The gate flag is a run input, so no worker or reviewer turn can supply it, and a re-finish repeats this refusal. The only outcome you own is abort with the reason naming the missing --require-ci ${pr} gate, because this run cannot end through finish. A finish that records the unresolved compare is refused with this, because the gate resolves that PR head.`,
  };
}
