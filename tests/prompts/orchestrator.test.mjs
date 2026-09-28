import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  initialPrompt,
  refusalPrompt,
  repairPrompt,
  resultPrompt,
} from "../../src/prompts/orchestrator.mjs";

const instructionsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/orchestrator-instructions.md",
);

// Usefulness: verifies initialPrompt produces exact expected string structure.
test("initialPrompt produces expected orchestrator prompt", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("You are the orchestrator in an automated multi-agent coding loop.");
  expect(prompt).toContain("maximum step budget of 10 steps");
  expect(prompt).toContain("Implement feature X");
  expect(prompt).toContain('{"action": "run_worker", "prompt": "<instructions for worker>"}');
});

// Usefulness: verifies the headless prompt states the notes and deferred finish
// mapping that the interactive instructions also carry: carry deferred items
// forward, record resolved ones in changed, map unaddressed notes to open, and
// split review-only findings between open and deferred (issue #214).
test("initialPrompt states the notes and deferred finish mapping", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("Each child turn ends with a closing report block");
  expect(prompt).toContain("Carry each Deferred item forward");
  expect(prompt).toContain("record it in changed");
  expect(prompt).toContain("Reviewer Notes that no later turn addressed go into open");
  expect(prompt).toContain("obtain another reviewer accept on the new state before finish");
  expect(prompt).toContain("In review-only mode, Blockers and Notes go into open");
  expect(prompt).toContain("deferred holds out-of-scope items in every mode");
});

// Usefulness: verifies the headless parent names the guards and contracts at risk
// in a reviewer prompt and does not restate the spec as the pass condition,
// matching the interactive reviewer-prompt rule (issue #228).
test("initialPrompt states the reviewer-prompt guard and contract rule", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain(
    "name the guards and contracts that the change puts at risk, so the reviewer can trace each changed input through them",
  );
  expect(prompt).toContain(
    "Do not restate the spec as the pass condition: a restated spec asks the reviewer to confirm it, not to test it",
  );
});

// Usefulness: verifies the headless parent knows every child turn reports its
// commands, and that only the reviewer Checks line gates, so a reported worker
// Checks line never reads as an accept (issue #310). Matched as rule fragments
// instead of a full sentence, so a reword that keeps the rule keeps the
// assertion (issue #318).
test("initialPrompt states that only the reviewer Checks line gates", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toMatch(/every child turn reports a checks line/i);
  expect(prompt).toMatch(/only the reviewer checks line is a gate input/i);
  expect(prompt).toMatch(/worker checks line .*never an accept/i);
});

// Usefulness: verifies the headless parent states the same reviewed-state rules
// as the interactive instructions: compare head, require clean, and treat an
// accept without a Checks line as not accepted (issue #217).
test("initialPrompt states the reviewed-state parent rules", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain(
    "Compare reviewed.head with the PR head before finish; for PR work, resolve the PR head from the run's PR number.",
  );
  expect(prompt).toContain("Require reviewed.clean: true for PR work.");
  expect(prompt).toContain("Treat an accept without a Checks line as not accepted.");
  expect(prompt).toContain(
    "When the PR head cannot be resolved, for example a read-only turn with no network access, do not finish as verified: abort, or record the unresolved compare under notDone and open in the finish summary.",
  );
});

// Usefulness: verifies the headless prompt names the machine-readable marker the
// parent sets when it records an unresolved PR-head compare, and shows it inside
// the finish action object, so the runtime can turn it into a distinct
// unresolved-compare event (issue #266).
test("initialPrompt names the unresolvedCompare marker", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain(
    'When you record an unresolved PR-head compare in a finish instead of aborting, add "unresolvedCompare": true to the finish action.',
  );
  expect(prompt).toContain(
    "For an unresolved PR-head compare, add the marker inside the same action object:",
  );
  expect(prompt).toContain(
    '{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}, "unresolvedCompare": true}',
  );
  expect(prompt).toContain("unresolved-compare event");
  expect(prompt).toContain("exits 4 instead of 0");
  // The marker is the only machine-readable record of the compare, so the prompt
  // must state that consequence and the instruction to set it, or the parent has
  // no reason to comply beyond the rule (#286).
  expect(prompt).toContain(
    "nothing else in the run distinguishes an omitted marker from a verified finish, so always set it.",
  );
});

// Usefulness: verifies the interactive instructions and the headless prompt
// state the same reviewed-state parent rules, so the two parent paths never
// diverge (issue #217, issue #252). A rule that needs more than a literal match
// is listed as a pattern, so both texts are still compared for it (issue #318).
test("interactive instructions and headless prompt share the reviewed-state rules", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  const patterns = [
    /only the reviewer checks line is a gate input/i,
    /worker checks line .*never an accept/i,
  ];
  for (const rule of [
    "A task is PR work when its change is delivered on a pull request.",
    "For PR work, name the PR branch in the worker prompt: the worker commits its change on that branch and pushes it, so the PR head equals the reviewed head.",
    "The run supplies the PR number, and the head commit comes from that PR.",
    "In a headless run, the task names the PR number.",
    "Compare reviewed.head with the PR head before finish; for PR work, resolve the PR head from the run's PR number.",
    "Require reviewed.clean: true for PR work.",
    "Treat an accept without a Checks line as not accepted.",
    "When the PR head cannot be resolved, for example a read-only turn with no network access, do not finish as verified: abort, or record the unresolved compare under notDone and open in the finish summary.",
  ]) {
    expect(instructions).toContain(rule);
    expect(prompt).toContain(rule);
  }
  for (const pattern of patterns) {
    expect(instructions).toMatch(pattern);
    expect(prompt).toMatch(pattern);
  }
});

// Usefulness: verifies the headless result payload carries the reviewer reviewed
// state, so the orchestrator sees the same runtime identity the child cannot
// misreport (issue #217).
test("resultPrompt carries the reviewed state for a reviewer result", () => {
  const reviewed = { head: "abc", clean: true, exact: true, digest: "d" };
  const prompt = resultPrompt({
    result: { role: "reviewer", status: "ok", response: "done", reviewed },
    stepsUsed: 1,
    maxSteps: 3,
  });
  expect(prompt).toContain('"reviewed"');
  expect(prompt).toContain('"digest": "d"');
});

// Usefulness: verifies the headless prompt states the completion rule and its
// mode mapping: a worker change needs a later reviewer accept, a run with no
// worker turn finishes on the report, and the loop policy stays interactive
// (issue #234).
test("initialPrompt states the completion rule and its mode mapping", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("Do not finish while the latest changed state lacks a reviewer accept");
  expect(prompt).toContain("a later reviewer turn returns Verdict: accept on that state");
  expect(prompt).toContain("When no worker turn has run");
  expect(prompt).toContain("loop policy");
});

// Usefulness: verifies the headless prompt names the deterministic gate when the
// run is started with --require-accept (issue #234).
test("initialPrompt states the --require-accept gate when enabled", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10, requireAccept: true });
  expect(prompt).toContain("--require-accept");
  expect(prompt).toContain("refuses a finish");
});

// Usefulness: verifies the headless prompt names the PR gate and tells the parent
// that the runtime resolves the head, so a gated run does not report a compare
// the runtime verifies, and the prompt is unchanged without the flag (issue #293).
test("initialPrompt states the --require-ci gate when enabled", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10, requireCi: 42 });
  expect(prompt).toContain("--require-ci 42");
  expect(prompt).toContain("resolves the PR head");
  expect(initialPrompt({ task: "Implement feature X", maxSteps: 10 })).not.toContain(
    "--require-ci",
  );
});

// Usefulness: verifies refusalPrompt carries the refusal reason and the supported
// actions, so the orchestrator can recover with a reviewer turn (issue #234).
test("refusalPrompt states the reason and the supported actions", () => {
  const prompt = refusalPrompt("Finish refused: no reviewer accept.");
  expect(prompt).toContain("Finish refused: no reviewer accept.");
  expect(prompt).toContain("Supported actions: run_worker, run_reviewer, finish, abort.");
});

// Usefulness: verifies resultPrompt produces expected formatted payload for ok result.
test("resultPrompt produces expected prompt for ok result", () => {
  const prompt = resultPrompt({
    result: { role: "worker", status: "ok", response: "all done" },
    stepsUsed: 2,
    maxSteps: 5,
  });
  expect(prompt).toContain('"role": "worker"');
  expect(prompt).toContain('"status": "ok"');
  expect(prompt).toContain('"response": "all done"');
  expect(prompt).toContain('"stepsUsed": 2');
  expect(prompt).toContain('"stepsRemaining": 3');
});

// Usefulness: verifies resultPrompt produces expected formatted payload for error result.
test("resultPrompt produces expected prompt for error result", () => {
  const prompt = resultPrompt({
    result: { role: "reviewer", status: "error", error: "timed out" },
    stepsUsed: 1,
    maxSteps: 1,
  });
  expect(prompt).toContain('"role": "reviewer"');
  expect(prompt).toContain('"status": "error"');
  expect(prompt).toContain('"error": "timed out"');
  expect(prompt).toContain('"stepsRemaining": 0');
});

// Usefulness: verifies repairPrompt states the error and formats the repair request.
test("repairPrompt produces expected repair prompt", () => {
  const prompt = repairPrompt("Unsupported action: foo");
  expect(prompt).toContain("Unsupported action: foo");
  expect(prompt).toContain('{"action": "run_worker", "prompt": "<string>"}');
});

// Usefulness: verifies the repair format shows both the plain finish object and
// the marked finish object, with unresolvedCompare inside the object, so a
// repaired verified finish is not copied from the marked form (issue #266).
test("repairPrompt shows both finish forms with unresolvedCompare inside the object", () => {
  const prompt = repairPrompt("finish unresolvedCompare must be a boolean.");
  expect(prompt).toContain(
    '3. {"action": "finish", "summary": {"changed": "<string>", "verified": "<string>", "deferred": "<string>", "notDone": "<string>", "open": "<string>"}}\nFor an unresolved PR-head compare, add the marker inside the same object:',
  );
  expect(prompt).toContain(
    '{"action": "finish", "summary": {"changed": "<string>", "verified": "<string>", "deferred": "<string>", "notDone": "<string>", "open": "<string>"}, "unresolvedCompare": true}',
  );
});
