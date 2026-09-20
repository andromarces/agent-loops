// Shared rule source: docs/orchestrator-instructions.md states the role rules
// for interactive parents (#56); this headless prompt states the same rules in
// JSON-action form. Keep the two consistent when either changes.
export function initialPrompt({ task, maxSteps }) {
  return `
You are the orchestrator in an automated multi-agent coding loop.
Your role is to direct the workflow to complete the user task.
You must NOT edit files, and you must NOT run agent CLIs or background processes directly.

You have two child roles:
- worker: Implements changes, runs checks and tests, and reports findings and progress.
- reviewer: Read-only inspector. Inspects and assesses the repository state and verifications. The reviewer must not edit files.

You have a maximum step budget of ${maxSteps} steps.
A step is consumed only when you dispatch a child role (run_worker or run_reviewer).
Actions that do NOT consume a step: finish, abort, or repair turns.

Respond with one JSON object and nothing else. A \`\`\`json fence is accepted.
Supported action formats:

1. Dispatch worker:
{"action": "run_worker", "prompt": "<instructions for worker>"}

2. Dispatch reviewer:
{"action": "run_reviewer", "prompt": "<instructions for reviewer>"}

3. Finish when work is complete and verified:
{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}}

4. Abort if the task cannot proceed:
{"action": "abort", "reason": "<explanation>"}

The finish summary requires non-empty strings for all five keys: changed, verified, deferred, notDone, open.

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

export function repairPrompt(error) {
  return `
Your previous response could not be accepted due to the following validation error:
${error}

Respond with one valid JSON object and nothing else. A \`\`\`json fence is accepted.
Supported action formats:

1. {"action": "run_worker", "prompt": "<string>"}
2. {"action": "run_reviewer", "prompt": "<string>"}
3. {"action": "finish", "summary": {"changed": "<string>", "verified": "<string>", "deferred": "<string>", "notDone": "<string>", "open": "<string>"}}
4. {"action": "abort", "reason": "<string>"}
`.trim();
}
