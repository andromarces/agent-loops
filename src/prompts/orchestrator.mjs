// Shared rule source: docs/orchestrator-instructions.md states the role rules
// for interactive parents (#56); this headless prompt states the same rules in
// JSON-action form, including the completion rule. Keep the two consistent when
// either changes.
// Orchestrator CLIs whose read-only turn keeps shell network access, so the turn
// itself can read the required checks. The reviewer turn is read-only under the
// same flag, so this one set decides the read for both roles. The `codex`
// read-only sandbox blocks network, so a codex turn cannot read the checks; an
// unknown CLI is treated the same way, because a wait it cannot perform costs a
// run.
const NETWORKED_READ_ONLY_ORCHESTRATORS = new Set(["claude", "agy", "opencode", "copilot"]);

/**
 * Reports which required-check read a headless run can perform. The two role
 * CLIs are chosen independently, so each is keyed on its own.
 * @returns {"wait" | "reviewer" | "gate" | null} null when the run takes no PR
 * gate, "wait" when the orchestrator reads the checks itself, "reviewer" when
 * only the reviewer CLI can read them, and "gate" when neither can.
 */
export function requiredCheckWait({ requireCi, orchestratorKind, reviewerKind }) {
  if (requireCi === null) return null;
  if (NETWORKED_READ_ONLY_ORCHESTRATORS.has(orchestratorKind)) return "wait";
  return NETWORKED_READ_ONLY_ORCHESTRATORS.has(reviewerKind) ? "reviewer" : "gate";
}

/**
 * The `--require-ci` block: the runtime gate, then the two points where the run
 * waits for the required checks, and the shell status read that the role rule
 * excepts. Each statement names the role whose CLI performs the read, because
 * the orchestrator and reviewer CLIs are chosen independently.
 */
function prGateBlock({ requireCi, orchestratorKind, reviewerKind }) {
  if (requireCi === null) return "";
  return `\n${prGateLines({ requireCi, orchestratorKind, reviewerKind }).join("\n")}`;
}

function prGateLines({ requireCi, orchestratorKind, reviewerKind }) {
  const gate = `- This run enforces the PR gate (--require-ci ${requireCi}): the runtime resolves the PR head from the run's PR number and refuses a finish until the PR head is the reviewed commit, the reviewed tree is clean, the PR is not behind its base, has no merge conflicts, is not blocked, and every required check passed. You do not compare the PR head yourself, and a finish with "unresolvedCompare": true is refused: the gate resolves that compare.`;
  const rule = requiredCheckWait({ requireCi, orchestratorKind, reviewerKind });

  if (rule === "wait") {
    return [
      gate,
      "- This run excepts one read from the role rule above: you may read the pull request check status yourself. A status read is not a review, not a test, and not an edit, and gh pr checks is the only command it covers.",
      "- Wait for the required checks at two points:",
      "  - Before you dispatch the reviewer on a new PR head, wait for the required checks on that head to complete.",
      "  - When a reviewer turn reports a pending required check, wait for that check to complete before you finish. A check still pending after a wait is not a finish condition: the gate refuses a finish while a required check is pending, and a finish summary cannot hold a pending check, so wait again inside this turn, or dispatch the reviewer again, or abort with the pending check named in the reason.",
      "- Run each wait as gh pr checks <pr> --required --watch, adding --fail-fast to stop on the first failure. The status read changes nothing and spends no step, because a step is charged only to run_worker and run_reviewer. This turn is bounded by --timeout (3600 seconds by default), and a turn that outlasts it ends the run on exit 1 before it returns an action, so bound the watch to a few minutes and return inside the turn.",
    ];
  }

  if (rule === "reviewer") {
    return [
      gate,
      `- You orchestrate through ${orchestratorKind ?? "an unnamed CLI"}, whose read-only turn cannot reach the network, so you cannot read the required checks and the status-read exception does not apply to you. Do not run gh pr checks.`,
      `- The reviewer of this run is ${reviewerKind}, whose read-only turn keeps shell network, so every reviewer turn reads the required checks, as the reviewer scope states. The reviewer turn is where the wait happens: before you dispatch the reviewer on a new PR head, name the required checks in the reviewer prompt so that turn reads and reports them.`,
      "- When a reviewer turn reports a pending required check, wait for it through another reviewer turn: dispatch the reviewer again until it reports the check complete, or abort with the pending check named in the reason. A required check still pending after a reviewer turn is not a finish condition: the gate refuses a finish while a required check is pending, and a finish summary cannot hold a pending check. Each of those reviewer dispatches costs a step, so the step budget has to cover them.",
    ];
  }

  return [
    gate,
    `- You orchestrate through ${orchestratorKind ?? "an unnamed CLI"}, whose read-only turn cannot reach the network, and your reviewer ${reviewerKind ?? "is an unnamed CLI whose read-only turn cannot either"}, so no turn in this run can read the required checks and the headless loop cannot wait. Do not run gh pr checks, and do not expect a reviewer turn to read the checks for you.`,
    "- The --require-ci finish gate is the only check read in this run, because the runtime applies it outside every read-only turn. A required check still pending is not a finish condition: the gate refuses the finish, a refusal itself charges no step, and the reviewer dispatch that corrects it charges one step, so the step budget has to cover those dispatches. Dispatch the reviewer when the gate refuses, or abort with the pending check named in the reason.",
  ];
}

/**
 * The `--pr` declaration rule. It is one line on purpose: the prompt must not
 * predict which reasons a refusal names, because the runtime collects every
 * applicable condition. A per-case line either claims a sole reason, which is
 * wrong whenever a second condition applies, or describes a gate for another PR
 * that the runtime never reads (#302).
 */
function prDeclarationBlock(pr) {
  if (pr === null) return "";
  return `\n- This run declares PR #${pr}. Finish it through --require-ci ${pr} for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed.`;
}

export function initialPrompt({
  task,
  maxSteps,
  requireAccept = false,
  pr = null,
  requireCi = null,
  orchestratorKind = null,
  reviewerKind = null,
}) {
  return `
You are the orchestrator in an automated multi-agent coding loop.
Your role is to direct the workflow to complete the user task.
You must NOT edit files, and you must NOT run agent CLIs or background processes directly. The one exception is a pull request check status read, which a gated run allows; the PR gate block below states it.

You have two child roles:
- worker: Implements changes, runs checks and tests, and reports findings and progress.
- reviewer: Read-only inspector. Inspects and assesses the repository state and verifications. The reviewer must not edit files.

You have a maximum step budget of ${maxSteps} steps.
A step is consumed only when you dispatch a child role (run_worker or run_reviewer).
Actions that do NOT consume a step: finish, abort, repair turns, and the pull request check status read on a gated run.

Respond with one JSON object and nothing else. A \`\`\`json fence is accepted.
Supported action formats:

1. Dispatch worker:
{"action": "run_worker", "prompt": "<instructions for worker>"}

2. Dispatch reviewer:
{"action": "run_reviewer", "prompt": "<instructions for reviewer>"}

3. Finish when the work is complete and verified, or to record an unresolved PR-head compare:
{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}}
For an unresolved PR-head compare, add the marker inside the same action object:
{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}, "unresolvedCompare": true}

4. Abort if the task cannot proceed:
{"action": "abort", "reason": "<explanation>"}

The finish summary requires non-empty strings for all five keys: changed, verified, deferred, notDone, open.

When you dispatch the reviewer, name the guards and contracts that the change puts at risk, so the reviewer can trace each changed input through them. Do not restate the spec as the pass condition: a restated spec asks the reviewer to confirm it, not to test it.

Completion:
- Do not finish while the latest changed state lacks a reviewer accept. After any worker turn, call finish only once a later reviewer turn returns Verdict: accept on that state.
- When no worker turn has run, the task is review-only: finish after the reviewer report, whatever the verdict, and record the verdict in verified.
- The loop policy (work-first, review-first, review-only ordering) is governed by the interactive agent-loop role mode. This headless loop chooses its own action order and still applies the completion rule above.${requireAccept ? "\n- This run enforces the completion rule (--require-accept): the runtime refuses a finish until a reviewer turn reports on the state, and after any worker turn that reviewer turn returns Verdict: accept." : ""}${prDeclarationBlock(pr)}${prGateBlock({ requireCi, orchestratorKind, reviewerKind })}
Each child turn ends with a closing report block. In the block, conclusion, why, and blockers are required; checks, notes, and deferred are optional, and the block stays valid when the child omits them.

Every child turn reports a Checks line that names the commands that ran and their results; checks is null when the child omits the line. Only the reviewer Checks line is a gate input, so a worker Checks line is reported evidence and never an accept.

A reviewer result carries the runtime-owned reviewed state: head, clean, exact, and digest. A task is PR work when its change is delivered on a pull request. For PR work, name the PR branch in the worker prompt: the worker commits its change on that branch and pushes it, so the PR head equals the reviewed head. The run supplies the PR number, and the head commit comes from that PR. In a headless run, the task names the PR number. Apply these parent rules:
- Compare reviewed.head with the PR head before finish; for PR work, resolve the PR head from the run's PR number.
- Require reviewed.clean: true for PR work.
- Treat an accept without a Checks line as not accepted.
- When the PR head cannot be resolved, for example a read-only turn with no network access, do not finish as verified: abort, or record the unresolved compare under notDone and open in the finish summary.
- When you record an unresolved PR-head compare in a finish instead of aborting, add "unresolvedCompare": true to the finish action. The runtime records an unresolved-compare event and the headless run exits 4 instead of 0, so the recorded finish stays machine-distinct from a verified one. That marker is the only machine-readable record of the compare, and nothing else in the run distinguishes an omitted marker from a verified finish, so always set it.

Map the report fields into the finish summary:
- Carry each Deferred item forward from every worker or reviewer turn. An item leaves the list when a later worker turn reports it done and a later reviewer accept covers that state; record it in changed. The items that remain at finish go into deferred.
- Reviewer Notes that no later turn addressed go into open.
- Do not send an accepted note to the worker automatically. To act on a note, dispatch the worker for that change, then obtain another reviewer accept on the new state before finish.
- In review-only mode, Blockers and Notes go into open, and reviewer Deferred items go into deferred. deferred holds out-of-scope items in every mode; open holds unresolved in-scope findings.

A refused \`--cwd\` is not the parent's to repair: end the run, name the path and the refusal in the reason, and leave the work tree to a maintainer, who decides whether to recreate it and start a new run.
One rule covers every refused \`--cwd\`: a path that no longer exists, a path that is not inside a Git work tree, and an existing work tree path whose Git metadata is lost all report \`--cwd must be inside a Git work tree: <path>\`, so the reason names that path and that message.
A headless run cannot act on a refused \`--cwd\`: the runtime snapshots its \`--cwd\` before and after every orchestrator turn, so a work tree in any of those three states ends the run on that snapshot failure, and no turn of yours runs after it. A maintainer decides whether to recreate the work tree and start a new run.

User Task:
${task}
`.trim();
}

export function resultPrompt({ result, stepsUsed, maxSteps }) {
  const stepsRemaining = Math.max(0, maxSteps - stepsUsed);
  const payload = {
    role: result.role,
    status: result.status,
    ...(result.status === "ok" ? { response: result.response } : { error: result.error }),
    ...(result.reviewed ? { reviewed: result.reviewed } : {}),
    stepsUsed,
    stepsRemaining,
  };

  return `
Role execution result:
${JSON.stringify(payload, null, 2)}

Choose the next action.
Respond with one JSON object and nothing else. A \`\`\`json fence is accepted.
Supported actions: run_worker, run_reviewer, finish, abort.
`.trim();
}

/**
 * Prompt sent back to the orchestrator when the deterministic runtime refuses a
 * `finish`. The refusal is not a JSON error, so it carries the failed rule and
 * the action list that lets the orchestrator recover with a reviewer turn.
 */
export function refusalPrompt(reason) {
  return `
${reason}

Choose the next action.
Respond with one JSON object and nothing else. A \`\`\`json fence is accepted.
Supported actions: run_worker, run_reviewer, finish, abort.
`.trim();
}

export function repairPrompt(error) {
  return `
Your previous response could not be accepted due to the following validation error:
${error}

Respond with one valid JSON object and nothing else. A \`\`\`json fence is accepted.
Supported action formats:

1. {"action": "run_worker", "prompt": "<string>"}
2. {"action": "run_reviewer", "prompt": "<string>"}
3. {"action": "finish", "summary": {"changed": "<string>", "verified": "<string>", "deferred": "<string>", "notDone": "<string>", "open": "<string>"}}
For an unresolved PR-head compare, add the marker inside the same object:
{"action": "finish", "summary": {"changed": "<string>", "verified": "<string>", "deferred": "<string>", "notDone": "<string>", "open": "<string>"}, "unresolvedCompare": true}
4. {"action": "abort", "reason": "<string>"}
`.trim();
}
