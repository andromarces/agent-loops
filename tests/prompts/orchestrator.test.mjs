import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  initialPrompt,
  refusalPrompt,
  repairPrompt,
  requiredCheckWait,
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

// The reviewer-Checks gate rule, checked for presence only: one sentence names
// the reviewer Checks line and a gate input. A reword that keeps those two nouns
// passes, and a removed rule fails. Reading an inversion out of prose is out of
// scope here, so the behavior the rule describes is covered where it runs, in
// `--require-accept refuses a finish that relies on a worker Checks line` in
// tests/role.finish-abort.test.mjs.
const REVIEWER_GATE_SENTENCE =
  /[^.!?]*(?:reviewer'?s? checks line[^.!?]*gate input|gate input[^.!?]*reviewer'?s? checks line)[^.!?]*[.!?]/i;

/** Asserts the text states the reviewer-Checks gate rule. */
function expectReviewerGateRule(text) {
  expect(text).toMatch(REVIEWER_GATE_SENTENCE);
}

// The headless prompt also states that every child turn reports the line. The
// interactive instructions state that rule on `report.checks` instead, so this
// pattern guards the headless prompt only. The subject stays open (`every`,
// `each`) so a reword of the subject does not break the rule.
const EVERY_CHILD_TURN_CHECKS = /child turn[^.]*checks line/i;

// Usefulness: verifies the headless parent knows every child turn reports its
// commands, and that only the reviewer Checks line gates, so a reported worker
// Checks line never reads as an accept (issue #310).
test("initialPrompt states that only the reviewer Checks line gates", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toMatch(EVERY_CHILD_TURN_CHECKS);
  expectReviewerGateRule(prompt);
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
// diverge (issue #217, issue #252). The reviewer-Checks gate rule is compared by
// the same presence check the gate test uses, so a reword keeps the parity check
// and a removal breaks it (issue #318).
test("interactive instructions and headless prompt share the reviewed-state rules", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
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
  expectReviewerGateRule(instructions);
  expectReviewerGateRule(prompt);
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

// Usefulness: pins the exact text the headless prompt adds for a declared run, in
// the two combinations the headless CLI accepts: `--pr` alone, and `--pr` with a
// matching gate. A mismatched gate is a usage error before the prompt is built, so
// the prompt never has to describe a gate the runtime skips. Removing the block
// must restore the prompt a run without `--pr` gets, which is what keeps the
// undeclared prompt byte-identical to the one before the declaration (#302). The
// supplied-status clause is the one addition beyond that block, and only on the
// gated combination, because the runtime reads the status for a declared PR (#320).
test("the headless prompt adds exactly the declaration rule and nothing else", () => {
  const block =
    "- This run declares PR #42. Finish it through --require-ci 42 for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed.";
  const supplied =
    " This run declares PR #42, so the runtime reads the required-check status for that PR head and supplies it to every reviewer prompt. That status is advisory evidence, in place of the reviewer reading the checks: the reviewer reports it, keeps its own read as the fallback, and reads the checks itself when the supplied status is unresolved. The --require-ci finish gate re-reads GitHub and enforces the condition. The runtime reports the status it read beside the reviewer result, so compare it with the reviewer Checks line.";

  const noGate = initialPrompt({ task: "T", maxSteps: 10 });
  const withPr = initialPrompt({ task: "T", maxSteps: 10, pr: 42 });
  expect(withPr).toContain(`\n${block}\n`);
  expect(withPr.replace(`\n${block}`, "")).toBe(noGate);

  const gated = initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 });
  const withPrAndGate = initialPrompt({ task: "T", maxSteps: 10, pr: 42, requireCi: 42 });
  expect(withPrAndGate.replace(`\n${block}`, "").replace(supplied, "")).toBe(gated);
  expect(gated).not.toContain(supplied);
  // The origin/main gate line is still what follows, naming the declared PR.
  expect(withPrAndGate).toContain(
    `${block}\n- This run enforces the PR gate (--require-ci 42): the runtime resolves the PR head from the run's PR number and refuses a finish until the PR head is the reviewed commit`,
  );
});

// Usefulness: verifies a run that declares no PR keeps the prompt origin/main
// sends, because the declaration block is the only addition and it is empty
// without `--pr` (#302).
test("initialPrompt adds nothing to a run that declares no PR", () => {
  const prompt = initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 });
  expect(prompt).not.toContain("declares PR");
  expect(prompt).not.toContain("This run declares");
  // The origin/main gate block for the same inputs is still present and unchanged.
  expect(prompt).toContain(
    "This run enforces the PR gate (--require-ci 42): the runtime resolves the PR head from the run's PR number and refuses a finish until the PR head is the reviewed commit",
  );
});

// Usefulness: verifies the rule is keyed on the CLI of the role that reads the
// checks, because the orchestrator and reviewer CLIs are chosen independently,
// so a mixed run is never told that no turn can read them (issue #319).
test("requiredCheckWait reports the rule per orchestrator and reviewer CLI", () => {
  const rule = (orchestratorKind, reviewerKind) =>
    requiredCheckWait({ requireCi: 42, orchestratorKind, reviewerKind });
  expect(rule("claude", "claude")).toBe("wait");
  expect(rule("agy", "opencode")).toBe("wait");
  // The codex read-only sandbox blocks network, so a codex turn cannot read.
  expect(rule("codex", "claude")).toBe("reviewer");
  expect(rule("codex", "codex")).toBe("gate");
  // An unnamed CLI on either role cannot read the checks.
  expect(rule("codex", null)).toBe("gate");
  expect(requiredCheckWait({ requireCi: null, orchestratorKind: "claude" })).toBeNull();
  // An unnamed CLI renders as a CLI, not as a missing value.
  expect(initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 }).includes("through null")).toBe(
    false,
  );
});

const gatedPrompt = (orchestratorKind, reviewerKind = "claude") =>
  initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind,
    reviewerKind,
  });

// Usefulness: verifies a --require-ci run states the wait at both points that
// need it, the reviewer dispatch and the finish after a pending check, as two
// rules the parent can act on separately, for every orchestrator CLI whose
// read-only turn can read the checks (issue #319).
test("initialPrompt states the required-check wait at the reviewer and at finish", () => {
  for (const kind of ["claude", "agy", "opencode", "copilot"]) {
    const lines = gatedPrompt(kind).split("\n");
    const beforeReviewer = lines.find(
      (line) => /dispatch the reviewer/i.test(line) && /wait/i.test(line),
    );
    const beforeFinish = lines.find(
      (line) => /finish/i.test(line) && /pending/i.test(line) && /wait/i.test(line),
    );
    expect(beforeReviewer, kind).toBeTruthy();
    expect(beforeFinish, kind).toBeTruthy();
    expect(beforeFinish, kind).not.toBe(beforeReviewer);
  }
});

// Usefulness: verifies the pending-check wait point keeps a pending check out of
// the finish summary, because the --require-ci gate refuses a finish while a
// required check is pending, so the run must wait, re-review, or abort (issue #319).
test("the pending-check wait point does not put a pending check in a finish summary", () => {
  for (const kind of ["claude", "agy", "opencode", "copilot"]) {
    const line = gatedPrompt(kind)
      .split("\n")
      .find((entry) => /finish/i.test(entry) && /pending/i.test(entry) && /wait/i.test(entry));
    expect(line, kind).toMatch(/abort/i);
    expect(line, kind).not.toMatch(/notDone/);
  }
});

// Usefulness: verifies a run whose reviewer CLI keeps read-only network states
// that the reviewer turn is the check read, so a codex orchestrator with a
// networked reviewer is never told that no turn can read the checks (issue #319).
test("a mixed run reads the checks in the reviewer turn", () => {
  const prompt = gatedPrompt("codex", "claude");
  const reviewerRead = prompt
    .split("\n")
    .find((line) => /\bclaude\b/.test(line) && /reviewer/i.test(line) && /read/i.test(line));
  expect(reviewerRead).toBeTruthy();
  expect(prompt).not.toMatch(/no turn in this run can read/i);
  // The orchestrator cannot run the watch in this run.
  expect(prompt).not.toContain("--watch");

  const pending = prompt.split("\n").find((line) => /pending/i.test(line) && /abort/i.test(line));
  expect(pending).toBeTruthy();
  expect(pending).not.toMatch(/notDone/);
});

// Usefulness: verifies a run where neither role CLI keeps read-only network
// names the runtime gate as the only check read, and states that a gate refusal
// charges no step while the reviewer dispatch that corrects it does (issue #319).
test("a run with no read-only network on either role names the gate as the only check read", () => {
  const prompt = gatedPrompt("codex", "codex");
  const lines = prompt.split("\n");
  const cannotWait = lines.find((line) => /cannot wait/i.test(line));
  expect(cannotWait).toMatch(/codex/);
  expect(cannotWait).not.toMatch(/--watch/);
  expect(prompt).not.toMatch(/reviewer turn reads/i);

  const gateLine = lines.find((line) => /--require-ci/.test(line) && /only check read/i.test(line));
  expect(gateLine).toMatch(/refusal[^.]*no step/i);
  expect(gateLine).toMatch(/reviewer dispatch[^.]*step/i);
  expect(gateLine).toMatch(/abort/i);
  expect(gateLine).not.toMatch(/notDone/);
});

// Usefulness: verifies the wait rule follows the orchestrator CLI alone, because
// the orchestrator does the read when it can, whatever the reviewer CLI is
// (issue #319).
test("the wait rule does not depend on the reviewer CLI", () => {
  expect(gatedPrompt("claude", "codex")).toBe(gatedPrompt("claude", "claude"));
});

// Usefulness: verifies the prompt states the check status read as the one named
// exception to the orchestrator role rule, so the shell wait is inside the
// contract instead of against it (issue #319).
test("initialPrompt states the status read as the exception to the role rule", () => {
  const roleLine = gatedPrompt("claude")
    .split("\n")
    .find((line) => /must NOT run agent CLIs or background processes/i.test(line));
  expect(roleLine).toMatch(/exception/i);
  expect(roleLine).toMatch(/check status/i);
});

// Usefulness: verifies the two parent paths state the same narrow exception, so
// an interactive parent and a headless orchestrator resolve the role conflict the
// same way (issue #319).
test("interactive instructions and headless prompt share the status-read exception", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = gatedPrompt("claude").replace(/\s+/g, " ");
  for (const rule of ["status read", "not a review", "not a test"]) {
    expect(instructions).toContain(rule);
    expect(prompt).toContain(rule);
  }
});

// Usefulness: verifies the wait rule states the turn cost, because a headless
// orchestrator turn that outlasts the per-invocation timeout ends the run instead
// of returning an action (issue #319).
test("initialPrompt states that a wait can end the run at the turn timeout", () => {
  const prompt = gatedPrompt("claude");
  expect(prompt).toMatch(/--timeout/);
  expect(prompt).toMatch(/exit 1/);
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

// Usefulness: verifies a run that declares its PR is told the runtime supplies
// the required-check status, so an orchestrator whose own turn and whose
// reviewer both block the network is not left to expect a reviewer read that
// cannot happen (issue #320).
test("a declared PR states that the runtime supplies the required-check status", () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  });
  const supplied = prompt
    .split("\n")
    .find((line) => /suppl(y|ies) it to every reviewer/i.test(line));
  expect(supplied).toBeTruthy();
  expect(supplied).toMatch(/42/);
  // The rule that tells the reviewer to report the status without reading again
  // is the reviewer prompt's, not the orchestrator's.
  expect(supplied).toMatch(/reads the required-check status/i);
});

// Usefulness: verifies a gated run that declares no PR keeps its prompt, because
// the runtime has no PR input to read the status from (issue #320).
test("a gated run with no declared PR does not state a supplied status", () => {
  expect(gatedPrompt("codex", "codex")).not.toMatch(/suppl(y|ies) it to every reviewer/i);
});

// Usefulness: verifies the interactive instructions and the headless prompt
// state the supplied-status rule the same way, because the two paths resolve the
// same rule for a parent and a drifted statement would tell one of them the
// reviewer still reads the checks (issue #320 review).
test("interactive instructions and headless prompt state the supplied-status rule alike", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  }).replace(/\s+/g, " ");
  for (const rule of [
    "supplies it to every reviewer prompt",
    "advisory evidence",
    "in place of the reviewer reading the checks",
    "keeps its own read as the fallback",
    "unresolved",
    "re-reads GitHub and enforces the condition",
    "compare it with the reviewer Checks line",
  ]) {
    expect(instructions, rule).toContain(rule);
    expect(prompt, rule).toContain(rule);
  }
});

// Usefulness: verifies the headless prompt does not tell the orchestrator that no
// reviewer turn will read the checks in a run that declares its PR, because the
// runtime supplies the status and the reviewer keeps its own read as the
// fallback, so the two statements in one line would otherwise contradict each
// other (issue #320 review, second round).
test("a declared PR does not contradict itself about who reads the checks", () => {
  const line = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  })
    .split("\n")
    .find((text) => /supplies it to every reviewer prompt/.test(text));
  expect(line).toBeTruthy();
  // The fallback is a real read the reviewer may make, so the prompt must not
  // also tell the orchestrator not to expect a reviewer read.
  expect(line).not.toMatch(/do not expect a reviewer turn to read the checks/);
});

// Usefulness: verifies the two surfaces state the supplied-status rule in the
// same order and with the same conditions, so a parent reading the instructions
// and an orchestrator reading the prompt resolve one rule
// (issue #320 review, second round).
test("the supplied-status rule states the same conditions in both surfaces", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const declared = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  }).replace(/\s+/g, " ");

  // Same conditions, in the same order, on both surfaces.
  for (const [first, second] of [
    ["supplies it to every reviewer prompt", "advisory evidence"],
    ["advisory evidence", "keeps its own read as the fallback"],
    ["keeps its own read as the fallback", "supplied status is unresolved"],
    ["supplied status is unresolved", "re-reads GitHub and enforces the condition"],
    ["re-reads GitHub and enforces the condition", "compare it with the reviewer Checks line"],
  ]) {
    expect(instructions.indexOf(first), first).toBeGreaterThanOrEqual(0);
    expect(declared.indexOf(first), first).toBeGreaterThanOrEqual(0);
    expect(declared.indexOf(first), first).toBeLessThan(declared.indexOf(second));
  }
  expect(instructions.indexOf("supplies it to every reviewer prompt")).toBeLessThan(
    instructions.indexOf("keeps its own read as the fallback"),
  );
  // The moved-head gap is stated once, not twice, so the two surfaces cannot
  // drift into two versions of the same accepted gap.
  const movedMentions = instructions.match(/separate reads, and the pull request can advance/g);
  expect(movedMentions).toHaveLength(1);
});

// Usefulness: verifies a line that calls the finish gate the only check read is
// qualified for the advisory runtime read, because the same prompt states that
// the runtime supplies the status to the reviewer. Without the qualification the
// two statements contradict each other: one says the runtime reads the checks
// and supplies the status, the other says nothing else reads them
// (issue #320 review, fourth round).
test("a line calling the gate the only check read names the advisory runtime read", () => {
  for (const [label, text] of [
    ["headless prompt", declaredBothBlocked()],
    ["interactive instructions", null],
  ]) {
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (!/only check read/i.test(line)) continue;
      // The line must scope the claim to the reads that enforce, and must not
      // leave the advisory read unmentioned.
      expect(line, label).toMatch(/enforc/i);
      expect(line, label).toMatch(/advisory/i);
    }
  }
});

// Usefulness: verifies the qualification is checked on the interactive
// instructions too, since the two surfaces must state the same rule
// (issue #320 review, fourth round).
test("the instructions qualify the only-check-read claim the same way", async () => {
  const instructions = await readFile(instructionsPath, "utf8");
  const lines = instructions.split("\n").filter((line) => /only check read/i.test(line));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/enforc/i);
    expect(line).toMatch(/advisory/i);
  }
});

// A declared-PR, gated run in which neither role CLI reaches the network: the
// case where the prompt both supplies the status and names the gate.
const declaredBothBlocked = () =>
  initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  });
