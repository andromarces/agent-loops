// Shared run state and work tree lock helpers of `agent-loop role`. They are the required state
// read, the unreadable-gate refusal, the prompt stdin read, and the acquire and release of the run lock.
import { readStdinText } from "../lib/args.mjs";
import { unreadableGateReason } from "../lib/ci-gate.mjs";
import { unreadableGateRefusal } from "../lib/gate-refusal.mjs";
import { cwdHash } from "../lib/runstate.mjs";
import { lockWorkTree, unlockWorkTree } from "../lib/work-tree-lock.mjs";
import { RoleError } from "./envelope.mjs";

// The recovery that the interactive path owns when it cannot declare the PR. The runtime compares
// the head, where the headless path has only the parent's marker (#1098).
const ROLE_UNREADABLE_FINISH =
  "compare the PR head with the reviewed commit through `role finish --compare-head <pr>`, or finish with the unresolvedCompare marker after you compare it yourself";

/**
 * Rejects a non-init call when no state file exists for the work tree.
 *
 * `needsBudget` refuses an unsafe stored `maxSteps` before the operation runs.
 * A later dispatch, `finish`, and `extend` set it. `abort` leaves it unset.
 * Refusing it blocks the only route to a terminal lifecycle, because a new init
 * refuses over a non-terminal run (#312).
 */
export function requireState(state, cwd, { needsBudget = false } = {}) {
  if (!state) {
    throw new RoleError(
      `No run state for ${cwd}. Start one with: agent-loop role --task "..." --worker ... --reviewer ...`,
    );
  }
  if (needsBudget) {
    assertStateMaxSteps(state);
  }
  return state;
}

/**
 * A stored `maxSteps` is re-checked wherever the budget is read. A state
 * file written by an earlier version, or hand-edited, reaches the step-budget
 * guard without `--max-steps` validation. Outside the safe integer range the
 * step counter cannot advance by one, so no accepted value holds the bound on
 * `turns`. The refusal names the state file field, which is what a maintainer
 * must correct (#312).
 */
function assertStateMaxSteps(state) {
  if (!Number.isSafeInteger(state.maxSteps) || state.maxSteps < 1) {
    throw new RoleError(
      `State file field maxSteps must be a positive safe integer, got: ${JSON.stringify(state.maxSteps ?? null)}.`,
    );
  }
}

/** Refuses a PR declaration whose required-check sources the finish gate cannot read (#1092). */
export async function refuseUnreadableGate(label, { pr, cwd, gh, signal }) {
  const reason = await unreadableGateReason({ pr, cwd, gh, signal });
  if (reason) {
    throw new RoleError(unreadableGateRefusal(label, reason, ROLE_UNREADABLE_FINISH));
  }
}

export const readStdin = () =>
  readStdinText("No prompt received on stdin. Pipe a prompt or use --prompt-file.");

/** Acquires the work tree lock of the run at `cwd`, binding it to that work tree's digest. */
export function acquireWorkTreeLock(cwd, { signal } = {}) {
  return lockWorkTree(cwd, { runId: cwdHash(cwd), signal });
}

/** Releases the work tree lock of the run at `cwd` when its reason names that work tree's digest. */
export function releaseWorkTreeLock(cwd, { signal } = {}) {
  return unlockWorkTree(cwd, { runId: cwdHash(cwd), signal });
}
