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

// A prompt rule is asserted as the short clause that carries it, never as a whole
// prompt sentence, so a same-meaning reword of the surrounding prose passes and a
// changed rule fails. Where the polarity of a rule is the contract, the clause
// keeps the negation and the action together, so "finish" cannot stand in for
// "do not finish". Where a runtime gate enforces a rule, the gate test covers the
// behavior, and this file only asserts that the prompt states the rule.

/** The clauses of a prompt or instruction text, whitespace collapsed. */
const clauses = (text) => text.replace(/\s+/g, " ").split(/[.;]\s+/);

// Asserts one clause of the text carries the rule. Every term must sit in that one
// clause, so a term moved to another clause, or swapped with another, fails.
function expectRule(text, ...terms) {
  const stated = clauses(text).some((clause) => terms.every((term) => term.test(clause)));
  expect(stated, `no clause carries ${terms.map(String).join(" ")}`).toBe(true);
}

// The target of every commit or push instruction in the text: the phrase after the
// preposition, up to the next clause mark. A commit and a push in one clause each
// yield a target, so a second target naming another branch is caught.
const BRANCH_TARGET =
  /\b(?:commit|push)(?:s|es)?\b[^.;]{0,40}?\b(?:on|onto|to)\s+([^,.;]{1,40}?)(?=\s+(?:and|so|but)\b|[,.;]|$)/gi;

// A target that names a branch instead of pointing at the one the dispatcher
// supplied. A back-reference is a determiner and the word "branch" and nothing
// else, so `main` and `the main branch` each name a branch of their own.
const NAMED_TARGET = /^(?!\s*(?:the|that|this|your|its)\s+branch(?:es)?\s*$)\S/i;

// Asserts no commit or push in the text targets a branch of the rule's own, so a
// target such as `main` or `origin/main` fails.
function expectNoNamedBranchTarget(text) {
  for (const target of commitTargets(text)) {
    expect(NAMED_TARGET.test(target), `the rule commits on ${target}, a branch of its own`).toBe(
      false,
    );
  }
}

/** Every commit or push target in the text, whitespace collapsed. */
function commitTargets(text) {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(new RegExp(BRANCH_TARGET.source, "gi"))].map((match) => match[1].trim());
}

// Usefulness: verifies initialPrompt states the role, the step budget, the task
// it completes, and the action format it answers with, so a headless turn runs
// the loop instead of answering prose (issue #328).
test("initialPrompt produces expected orchestrator prompt", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, /orchestrator/i, /automated/i, /\bagent/i, /\bloop\b/i);
  expectRule(prompt, /step budget/i, /\b10 steps\b/i);
  expect(prompt).toContain("Implement feature X");
  expect(prompt).toContain('{"action": "run_worker", "prompt": "<instructions for worker>"}');
});

// Usefulness: verifies the headless prompt states the notes and deferred finish
// mapping that the interactive instructions also carry: which labels the closing
// block requires, that deferred items persist, that a resolved item lands in
// changed, that unaddressed notes land in open, that a change made for a note
// needs a further reviewer accept, and that review-only findings split between
// open and deferred (issue #214, issue #328).
test("initialPrompt states the notes and deferred finish mapping", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  // Every child turn closes with a report block, and the block requires
  // conclusion, why, and blockers while checks, notes, and deferred are optional.
  expectRule(prompt, /report block/i, /child turn/i);
  expectRule(prompt, /conclusion/i, /\bwhy\b/i, /\bblockers\b/i, /required/i);
  expectRule(prompt, /\bchecks\b/i, /\bnotes\b/i, /\bdeferred\b/i, /optional/i);
  // A deferred item is carried forward. It leaves the list when a later worker
  // turn reports it done and a later reviewer accept covers that state, and the
  // outcome is recorded in changed. The condition and the outcome are two clauses
  // of one mapping, so each is checked where the prompt states it.
  expectRule(prompt, /\bdeferred\b/i, /forward/i, /\bcarry\b/i);
  expectRule(prompt, /leaves the list[^.!?]{0,80}\bworker\b/i, /\baccept\b/i);
  expectRule(prompt, /\brecord[^.!?]{0,20}\bin changed\b/i);
  // The items still listed at finish go into deferred.
  expectRule(prompt, /\bitem[^.!?]{0,40}\bgo into deferred/i);
  // A reviewer note no later turn addressed goes into open.
  expectRule(prompt, /note[^.!?]{0,40}\bgo into open/i);
  // The note is not handed to the worker on its own. The negation stays with the
  // action, so "send" cannot stand in for "do not send".
  expectRule(prompt, /do not send[^.!?]{0,40}\bnote/i, /worker/i);
  // Acting on a note goes through the worker, and a further reviewer accept covers
  // the new state before finish.
  expectRule(
    prompt,
    /dispatch[^.!?]{0,40}\bworker/i,
    /note/i,
    /\baccept/i,
    /new state/i,
    /finish/i,
  );
  // In review-only mode, Blockers and Notes go into open, and reviewer Deferred
  // items go into deferred, which holds out-of-scope items in every mode while
  // open holds unresolved in-scope findings.
  expectRule(prompt, /review-only[^.!?]{0,80}\bblockers/i, /note/i, /go into open/i);
  expectRule(prompt, /reviewer[^.!?]{0,40}\bdeferred[^.!?]{0,40}\bgo into deferred/i);
  expectRule(prompt, /\bdeferred\b/i, /out-of-scope/i, /every mode/i);
  expectRule(prompt, /\bopen\b/i, /unresolved/i, /in-scope/i);
});

// Usefulness: verifies the headless parent names the guards and contracts at risk
// in a reviewer prompt and does not restate the spec as the pass condition,
// matching the interactive reviewer-prompt rule (issue #228, issue #328).
test("initialPrompt states the reviewer-prompt guard and contract rule", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, /name[^.!?]{0,60}guards/i, /reviewer/i, /at risk/i, /trace/i);
  // The negation stays with the action, so "restate" cannot stand in for "do not
  // restate".
  expectRule(prompt, /do not restate[^.!?]{0,40}spec/i, /pass condition/i);
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

// The rule-bearing clauses of the reviewed-state parent rules. Each keeps the
// action with the term that gives it meaning, so a reversed rule fails: the
// compare names both heads, `reviewed.clean: true` keeps its value, an accept
// without a Checks line is not accepted, and the unresolved-compare rule keeps
// "do not finish as verified" with its abort and its record.
const COMPARE_BEFORE_FINISH =
  /compare[^.!?]{0,40}reviewed\.head[^.!?]{0,40}PR head[^.!?]{0,40}\bfinish\b/i;
const RESOLVE_PR_HEAD = /resolve[^.!?]{0,40}PR head[^.!?]{0,40}PR number/i;
const REQUIRE_CLEAN_TRUE = /require[^.!?]{0,40}reviewed\.clean[^.!?]{0,20}\btrue\b/i;
const ACCEPT_WITHOUT_CHECKS =
  /treat[^.!?]{0,60}accept[^.!?]{0,40}without[^.!?]{0,20}Checks[^.!?]{0,20}not accepted/i;
// The unresolved-compare rule, clause by clause. `do not finish as verified` is
// the prohibition, and the clause that follows must name both permitted actions,
// `abort` and `record`, with the unresolved compare between them. The wording
// that joins the two options is not the contract, so a same-meaning join such as
// `abort or record` passes and dropping either action fails.
const UNRESOLVED_HEAD_CONDITION = /PR head cannot be resolved/i;
const DO_NOT_FINISH_AS_VERIFIED = /do not finish as verified/i;
const BOTH_ACTIONS_ON_UNRESOLVED =
  /abort[^.!?]{0,60}record[^.!?]{0,40}unresolved compare|record[^.!?]{0,60}abort[^.!?]{0,40}unresolved compare/i;
const RECORD_UNDER_NOT_DONE_AND_OPEN =
  /record[^.!?]{0,40}unresolved compare[^.!?]{0,40}notDone[^.!?]{0,20}\bopen\b/i;

// Usefulness: verifies the headless parent states the same reviewed-state rules
// as the interactive instructions: compare head, require clean, treat an accept
// without a Checks line as not accepted, and never finish as verified on an
// unresolved compare (issue #217, issue #328). The `--require-accept` and
// `--require-ci` gates enforce the compare and the clean requirement, covered by
// the gate tests in tests/role.finish-abort.test.mjs, so this asserts the prompt
// states the rules.
test("initialPrompt states the reviewed-state parent rules", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, COMPARE_BEFORE_FINISH);
  expectRule(prompt, RESOLVE_PR_HEAD);
  expectRule(prompt, REQUIRE_CLEAN_TRUE);
  expectRule(prompt, ACCEPT_WITHOUT_CHECKS);
  // The unresolved-compare rule, clause by clause: the condition, the prohibition,
  // both permitted actions on the unresolved compare, and the fields the record
  // uses.
  expectRule(prompt, UNRESOLVED_HEAD_CONDITION);
  expectRule(prompt, DO_NOT_FINISH_AS_VERIFIED);
  expectRule(prompt, BOTH_ACTIONS_ON_UNRESOLVED);
  expectRule(prompt, RECORD_UNDER_NOT_DONE_AND_OPEN);
});

// Usefulness: verifies the headless prompt names the machine-readable marker the
// parent sets when it records an unresolved PR-head compare, and shows it inside
// the finish action object, so the runtime can turn it into a distinct
// unresolved-compare event (issue #266, issue #328).
test("initialPrompt names the unresolvedCompare marker", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, /add[^.!?]{0,40}unresolvedCompare[^.!?]{0,20}\btrue\b/i, /finish/i);
  expectRule(prompt, /marker/i, /action object/i, /unresolved/i);
  expect(prompt).toContain(
    '{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}, "unresolvedCompare": true}',
  );
  expect(prompt).toContain("unresolved-compare event");
  expect(prompt).toContain("exits 4 instead of 0");
  // The marker is the only machine-readable record of the compare, so the prompt
  // must state that consequence and the instruction to set it, or the parent has
  // no reason to comply beyond the rule (#286).
  expectRule(prompt, /machine-readable/i, /omitted/i, /verified/i, /always set/i);
});

// The parent rules the interactive instructions and the headless prompt share.
// Each entry is one check run against both texts, so a rule that one text states
// and the other does not, or that either text states with the negation dropped or
// the action unbound, fails the parity check (issue #217, issue #252, #328).
const SHARED_PARENT_RULES = [
  (text) => expectRule(text, /PR work/i, /pull request/i),
  (text) =>
    expectRule(text, /name[^.!?]{0,40}PR branch/i, /worker/i, /commit/i, /push/i, /reviewed head/i),
  // Every commit or push the parent rule names must target the branch it just
  // named, never a branch of its own, so `on main` and `origin/main` fail.
  (text) => expectNoNamedBranchTarget(text),
  (text) => expectRule(text, /PR number/i, /head commit/i),
  (text) => expectRule(text, /headless/i, /task/i, /PR number/i),
  (text) => expectRule(text, COMPARE_BEFORE_FINISH),
  (text) => expectRule(text, RESOLVE_PR_HEAD),
  (text) => expectRule(text, REQUIRE_CLEAN_TRUE),
  (text) => expectRule(text, ACCEPT_WITHOUT_CHECKS),
  (text) => expectRule(text, UNRESOLVED_HEAD_CONDITION),
  (text) => expectRule(text, DO_NOT_FINISH_AS_VERIFIED),
  (text) => expectRule(text, BOTH_ACTIONS_ON_UNRESOLVED),
  (text) => expectRule(text, RECORD_UNDER_NOT_DONE_AND_OPEN),
];

// Usefulness: verifies the interactive instructions and the headless prompt
// state the same reviewed-state parent rules, so the two parent paths never
// diverge (issue #217, issue #252, issue #328). The reviewer-Checks gate rule is
// compared by the same presence check the gate test uses, so a reword keeps the
// parity check and a removal breaks it (issue #318).
test("interactive instructions and headless prompt share the reviewed-state rules", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  for (const rule of SHARED_PARENT_RULES) {
    rule(instructions);
    rule(prompt);
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
// (issue #234, issue #328). The gate the rule describes is covered where it runs,
// in `--require-accept refuses a finish after a worker turn with no later review`
// and `--require-accept refuses a finish that relies on a worker Checks line` in
// tests/role.finish-abort.test.mjs, so this check covers the prompt text.
test("initialPrompt states the completion rule and its mode mapping", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  // The completion rule, with the negation bound to the action, so a finish
  // before a reviewer accept cannot read as a finish after one.
  expectRule(prompt, /do not finish[^.!?]{0,60}changed state[^.!?]{0,60}reviewer accept/i);
  // The accept that satisfies it is the one a later reviewer turn returns for that
  // state, and finish waits for it.
  expectRule(prompt, /finish[^.!?]{0,40}\b(?:only|once|until)\b/i, /reviewer/i, /Verdict: accept/i);
  // With no worker turn, the task is review-only: finish on the reviewer report
  // whatever the verdict, and record that verdict in verified.
  expectRule(prompt, /worker/i, /review-only/i, /\bfinish\b/i);
  expectRule(prompt, /record[^.!?]{0,40}verified/i, /verdict/i);
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
// undeclared prompt byte-identical to the one before the declaration (#302).
test("the headless prompt adds exactly the declaration rule and nothing else", () => {
  const block =
    "- This run declares PR #42. Finish it through --require-ci 42 for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed.";

  const noGate = initialPrompt({ task: "T", maxSteps: 10 });
  const withPr = initialPrompt({ task: "T", maxSteps: 10, pr: 42 });
  expect(withPr).toContain(`\n${block}\n`);
  expect(withPr.replace(`\n${block}`, "")).toBe(noGate);

  const gated = initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 });
  const withPrAndGate = initialPrompt({ task: "T", maxSteps: 10, pr: 42, requireCi: 42 });
  expect(withPrAndGate.replace(`\n${block}`, "")).toBe(gated);
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
  const prompt = gatedPrompt("claude");
  const roleLine = prompt.split("\n").find((line) => /agent CLIs|background processes/i.test(line));
  expect(roleLine).toBeTruthy();
  // The negation stays with the action, so "must run" cannot stand in for "must
  // NOT run".
  expect(roleLine).toMatch(
    /must NOT (?:edit files[^.]{0,80}and you must NOT )?run agent CLIs or background processes/i,
  );
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

// The refused-`--cwd` rule both parent paths state the same way. It is the
// decision, not a repair procedure: a parent ends the run and a maintainer
// decides what happens to the work tree. The mechanism behind it differs by
// parent, so only the decision, the qualification, and the three refused cases
// are pinned here, and the test fails when either side drops them (issue #327).
const REFUSED_CWD_RULE = [
  "A refused `--cwd` is not the parent's to repair: end the run, name the path and the refusal in the reason, and leave the work tree to a maintainer, who decides whether to recreate it and start a new run.",
  "Abort only when a non-terminal run exists at the refused `--cwd`. With no run state there, from a refused init or a path that was never this run's, no run started, so report the refusal and do not abort. A run that is already terminal needs no abort.",
  "One rule covers every refused `--cwd`: a path that no longer exists, a path that is not inside a Git work tree, and an existing work tree path whose Git metadata is lost all report `--cwd must be inside a Git work tree: <path>`, so the reason names that path and that message.",
];

// Usefulness: verifies the interactive instructions and the headless prompt state
// the same refused-`--cwd` rule, so neither parent path sends a maintainer
// through a work tree repair that the runtime never asked for (issue #327).
test("interactive instructions and headless prompt share the refused --cwd rule", async () => {
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  for (const rule of REFUSED_CWD_RULE) {
    expect(instructions).toContain(rule);
    expect(prompt).toContain(rule);
  }
  // Neither text keeps the repair procedure or the unrecoverable claim.
  for (const gone of [
    "git worktree add",
    "git worktree prune",
    "not recoverable",
    "unrecoverable",
  ]) {
    expect(instructions).not.toContain(gone);
    expect(prompt).not.toContain(gone);
  }
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
