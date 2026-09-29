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
// the prompt never has to describe a gate the runtime skips. With `--pr` alone the
// declaration block is the only addition, so removing it restores the prompt a run
// without `--pr` gets, which is what keeps that undeclared prompt byte-identical to
// the one before the declaration (#302). With `--pr` and a gate the block is joined
// by the supplied-read clause, the advisory clause, and a reworded gate line, because
// the runtime supplies the status and the reviewer's own read is only a fallback;
// the undeclared gated prompt keeps the origin/main lines unchanged (#320).
test("the headless prompt adds the declaration rule and nothing else", () => {
  const block =
    "- This run declares PR #42. Finish it through --require-ci 42 for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed.";
  const supplied =
    " This run declares PR #42, so the runtime reads the required-check status for that PR head and supplies it to every reviewer prompt. That status is advisory evidence, in place of the reviewer reading the checks: the reviewer reports it, keeps its own read as the fallback, and reads the checks itself when the supplied status is unresolved. The --require-ci finish gate re-reads GitHub and enforces the condition. The runtime reports the status it read beside the reviewer result, so compare it with the reviewer Checks line.";
  // The gate line gains the advisory clause only for a declared PR, because the
  // runtime reads the status only for a declared PR.
  const advisory = " The advisory status read above reports to the reviewer and never enforces.";

  const noGate = initialPrompt({ task: "T", maxSteps: 10 });
  const withPr = initialPrompt({ task: "T", maxSteps: 10, pr: 42 });
  expect(withPr).toContain(`\n${block}\n`);
  expect(withPr.replace(`\n${block}`, "")).toBe(noGate);

  const gated = initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 });
  const withPrAndGate = initialPrompt({ task: "T", maxSteps: 10, pr: 42, requireCi: 42 });
  // A declared run's gate line is reworded, because it now has an advisory read
  // to distinguish from the enforcing one. Matched as a prefix: the line also
  // carries the advisory clause and the pending-check rule that follow it.
  const reworded =
    "- The --require-ci finish gate is the only check read in this run that enforces anything,";
  const undeclaredGate = gated.split("\n").find((line) => /only check read/.test(line));
  // The declared prompt carries the block, the supplied-read clause, and the
  // reworded gate line.
  expect(withPrAndGate.split("\n")).toContain(block);
  expect(withPrAndGate.split("\n").some((line) => line.startsWith(reworded))).toBe(true);
  expect(withPrAndGate).toContain(supplied.trim());
  // The undeclared run carries none of them, so the rewording cannot reach a run
  // that makes no supplied read.
  expect(gated.split("\n").some((line) => line.startsWith(reworded))).toBe(false);
  expect(gated).not.toContain(supplied);
  expect(gated).not.toContain(advisory);
  expect(undeclaredGate).toBeTruthy();
  expect(withPrAndGate).not.toContain(undeclaredGate);
  // The origin/main gate line is still what follows, naming the declared PR.
  expect(withPrAndGate).toContain(
    `${block}\n- This run enforces the PR gate (--require-ci 42): the runtime resolves the PR head from the run's PR number and refuses a finish until the PR head is the reviewed commit`,
  );
});

// Usefulness: verifies the headless prompt states that a gate on a base branch
// whose required-check sources each state it holds none passes on the PR head, the
// clean reviewed tree, and the merge state, and records the absence, so an
// orchestrator on such a branch knows the gate can pass and knows what it did not
// verify (issue #336).
test("the headless prompt states the no-required-check gate outcome", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
  });
  expectRule(prompt, /no required check/i, /pass/i, /PR head/i, /reviewed/i, /merge state/i);
  expectRule(prompt, /no required check/i, /record/i);
  // The rule names the condition the pass rests on, so an orchestrator whose
  // credential cannot read a source does not expect the gate to pass.
  expectRule(prompt, /required-check sources/i, /state/i);
  expectRule(prompt, /cannot read/i, /refus/i);
  // The same rule on the interactive surface, so the two parent paths do not
  // diverge on it.
  const instructions = await readFile(instructionsPath, "utf8");
  expectRule(instructions, /no required check/i, /pass/i, /PR head/i, /reviewed/i, /merge state/i);
  expectRule(instructions, /no required check/i, /record/i);
  expectRule(instructions, /cannot read/i, /refus/i);
});

// The surfaces that state the gate's empty-union rule. The reviewer found them
// contradicting each other, so one rule is asserted on each: only an allowlisted
// reply proves an absence, and a private Free-plan repository must omit `--pr`.
// Usefulness: verifies every surface states the same rule, so an orchestrator
// reading one is not told a run passes on a branch the gate refuses (#336 review).
const RULE_SURFACES = [
  ["docs/orchestrator-instructions.md", instructionsPath],
  ["README.md", join(dirname(fileURLToPath(import.meta.url)), "../../README.md")],
];

for (const [name, path] of RULE_SURFACES) {
  // Usefulness: verifies ${name} states the allowlist rule, the one absence per
  // source, and the pagination and rule-type unknown, so it cannot describe a
  // partial, malformed, or unreadable read as a pass (#336 review).
  test(`${name} states the allowlisted absence rule`, async () => {
    const text = await readFile(path, "utf8");
    expectRule(text, /allowlist/i, /fails closed/i);
    expectRule(text, /classes/i, /absent/i, /has-contexts/i, /empty/i, /unknown/i);
    // The one per-source absence each, and the ruleset read is every page.
    expectRule(text, /repository rulesets/i, /read of every page/i, /documented rule type/i);
    expectRule(text, /classic branch protection/i, /Branch not protected/);
    expectRule(text, /No successful classic-protection body proves an absence/i);
    // The empty result and the unknown rule type both settle nothing.
    expectRule(text, /empty ruleset result/i, /unknown/i);
    expectRule(text, /not a documented rule type/i, /unknown/i);
    // A rule on a later page is enforced rather than missed.
    expectRule(text, /paginated/i, /later page/i, /enforced/i);
  });

  // Usefulness: verifies ${name} states that an unknown ruleset read refuses whatever
  // the rest of the union holds, which is the case a non-empty union from another
  // source used to slip past (#336 review).
  test(`${name} states the three ruleset outcomes`, async () => {
    const text = await readFile(path, "utf8");
    // A read the gate cannot interpret refuses whatever the union holds.
    expectRule(text, /ruleset read the gate cannot interpret/i, /refuses the finish/i, /union/i);
    // A successful read that found no rule is neither, so a classic-only
    // repository still finishes.
    expectRule(text, /found no rule/i, /contributes no contexts/i, /origin.main/i);
  });

  // Usefulness: verifies ${name} states that an empty page inside a longer read
  // settles nothing, so a partial read is not classified from the pages that did
  // arrive (#336 review).
  test(`${name} states that an empty page inside a longer read settles nothing`, async () => {
    const text = await readFile(path, "utf8");
    expectRule(text, /empty page inside a longer read/i, /nothing/i);
  });

  // Usefulness: verifies ${name} states that a ruleset-only branch reaches the
  // absence path, the case an earlier claim got backwards (#336 review).
  test(`${name} states that a ruleset-only branch reaches the absence path`, async () => {
    const text = await readFile(path, "utf8");
    expectRule(text, /ruleset-only branch/i, /reaches|does/i);
  });

  // Usefulness: verifies ${name} states that a private Free-plan repository still
  // refuses a declared run and must omit `--pr`, so the gap #336 leaves is
  // visible to whoever reads it (#336 review).
  test(`${name} states that a private Free-plan repository must omit --pr`, async () => {
    const text = await readFile(path, "utf8");
    expectRule(text, /private/i, /Free.plan/i, /omit/i, /--pr/);
  });
}

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

// Usefulness: verifies a gated run that declares no PR is not told the runtime
// supplied an advisory status read, because the read follows `--pr` and this run
// has no `--pr`, so the prompt would describe a read the runtime never makes
// (issue #320 review, fifth round).
test("a gated run with no declared PR claims no supplied status read", () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  });
  // The runtime reads the status only for a declared PR, so an undeclared gated
  // run must carry no statement about a supplied read at all.
  expect(prompt).not.toMatch(/supplies it to every reviewer prompt/);
  expect(prompt).not.toMatch(/advisory status read/);
  // The gate claim stays, and needs no qualification here: with no supplied read
  // it really is the only check read, so it keeps the origin/main wording.
  expect(prompt).toMatch(/only check read in this run,/);
});

// Usefulness: verifies the declared-PR prompt keeps its supplied-read statement,
// so the conditional did not drop the rule from the run that does get the read
// (issue #320 review, fifth round).
test("a declared PR keeps its supplied status read statement", () => {
  const prompt = declaredBothBlocked();
  expect(prompt).toMatch(/supplies it to every reviewer prompt/);
  expect(prompt).toMatch(/advisory status read/);
});

// A reviewer result as `runLoop` hands it to `resultPrompt`, with the
// runtime-read status a declared-PR run attaches.
const REVIEWER_RESULT_WITH_CHECKS = {
  role: "reviewer",
  status: "ok",
  response: "Conclusion: ok\nWhy: tests\nBlockers: none\nChecks: npm test",
  reviewed: { head: "abc", clean: true, exact: true, digest: "d" },
  prChecks: {
    pr: 42,
    head: "abc",
    status: "failing",
    checks: ["ci (macos-latest)"],
    summary: "failing required checks on PR head abc: ci (macos-latest)",
    advisory: true,
  },
};

// Usefulness: verifies the headless orchestrator receives the runtime-read status
// in the rendered reviewer result, because the comparison the parent makes between
// that status and the reviewer Checks line needs both in the same prompt, and
// `resultPrompt` was the only place the result was rendered
// (issue #320 review, sixth round).
test("the result prompt carries the runtime-read required-check status", () => {
  const prompt = resultPrompt({
    result: REVIEWER_RESULT_WITH_CHECKS,
    stepsUsed: 1,
    maxSteps: 5,
  });
  expect(prompt).toMatch(/"prChecks"/);
  expect(prompt).toMatch(/"failing"/);
  // The head the status describes, so a parent can tell which commit it covers.
  expect(prompt).toMatch(/"head": "abc"/);
});

// Usefulness: verifies a worker result carries no status field, because only a
// reviewer turn reads the checks and an invented field on a worker result would
// read as a check status that was never read (issue #320 review, sixth round).
test("the result prompt carries no check status without one on the result", () => {
  const prompt = resultPrompt({
    result: { role: "worker", status: "ok", response: "done" },
    stepsUsed: 1,
    maxSteps: 5,
  });
  expect(prompt).not.toMatch(/prChecks/);
});

// The two lines origin/main renders for a gated run that declares no PR, pinned
// verbatim. A run with no `--pr` gets no supplied read, so the qualification the
// declared-PR prompt needs does not apply and must not be applied there: the
// undeclared gated prompt stays byte-identical to the one origin/main sends
// (issue #320 review, sixth round).
const MAIN_NO_NETWORK_LINE =
  "- You orchestrate through codex, whose read-only turn cannot reach the network, and your reviewer codex, so no turn in this run can read the required checks and the headless loop cannot wait. Do not run gh pr checks, and do not expect a reviewer turn to read the checks for you.";
const MAIN_GATE_LINE =
  "- The --require-ci finish gate is the only check read in this run, because the runtime applies it outside every read-only turn. A required check still pending is not a finish condition: the gate refuses the finish, a refusal itself charges no step, and the reviewer dispatch that corrects it charges one step, so the step budget has to cover those dispatches. Dispatch the reviewer when the gate refuses, or abort with the pending check named in the reason.";

// Usefulness: verifies a gated run that declares no PR renders exactly the two
// lines origin/main renders, because a run with no `--pr` makes no supplied
// read and must not carry wording about one, and a reworded line there changes a
// run this PR does not otherwise touch (issue #320 review, sixth round).
test("an undeclared gated prompt renders the origin/main lines unchanged", () => {
  const lines = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  }).split("\n");
  expect(lines).toContain(MAIN_NO_NETWORK_LINE);
  expect(lines).toContain(MAIN_GATE_LINE);
  // And no variant of either line, so a reword cannot slip in unnoticed.
  const variants = lines.filter((line) =>
    /no turn in this run can (read|reach) the (required )?checks|only check read/.test(line),
  );
  expect(variants).toEqual([MAIN_NO_NETWORK_LINE, MAIN_GATE_LINE]);
});
