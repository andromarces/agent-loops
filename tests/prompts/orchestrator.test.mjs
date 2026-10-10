import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vite-plus/test";
import { reviewerPrompt } from "../../src/prompts/reviewer.mjs";
import {
  initialPrompt,
  refusalPrompt,
  repairPrompt,
  requiredCheckWait,
  resultPrompt,
  waitChecksCommand,
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
// The unresolved-compare rule, clause by clause. `do not finish as verified` is the
// prohibition, and the clause that follows must offer both permitted actions as
// alternatives of one choice. The two actions are joined directly by `or`, and the run
// from `record` to `unresolved compare` may cross neither punctuation nor a clause, so
// the words of one option cannot be read out of two separate clauses or two separate
// choices. The order is not the contract, so both orders pass, and a clause that drops
// either action fails (issue #351).
const UNRESOLVED_HEAD_CONDITION = /PR head cannot be resolved/i;
const DO_NOT_FINISH_AS_VERIFIED = /do not finish as verified/i;
// Words between an action and the unresolved compare. No `.`, `;`, `:`, `?` or comma, so
// the gap stays inside one clause and inside one option.
const SAME_OPTION_GAP = "[^.();:?,]{0,40}";
const ABORT_THEN_RECORD_THE_COMPARE = new RegExp(
  `\\babort\\b,?\\s+or\\s+\\brecord\\b${SAME_OPTION_GAP}unresolved compare`,
  "i",
);
const RECORD_THE_COMPARE_THEN_ABORT = new RegExp(
  `\\brecord\\b${SAME_OPTION_GAP}unresolved compare\\b,?\\s+or\\s+\\babort\\b`,
  "i",
);
const BOTH_ACTIONS_ON_UNRESOLVED = new RegExp(
  `${ABORT_THEN_RECORD_THE_COMPARE.source}|${RECORD_THE_COMPARE_THEN_ABORT.source}`,
  "i",
);
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

// Usefulness: verifies a review-only headless run states the mapping the mode
// already carries in the interactive path: no worker dispatch, a finish that
// needs a dispatched reviewer turn, and the review-only summary mapping. A run
// without `--mode` keeps the mode-free prompt, so the block cannot reach a run
// that did not ask for it (issue #337).
test("a review-only run states the review-only mapping", () => {
  const reviewOnly = initialPrompt({ task: "T", maxSteps: 10, mode: "review-only" });
  expectRule(reviewOnly, /review-only/i, /do not dispatch[^.!?]{0,40}worker/i);
  expectRule(reviewOnly, /runtime/i, /refuses[^.!?]{0,40}run_worker/i);
  // The finish the mode records needs a reviewer turn, so the prompt states that
  // gate rather than leaving the orchestrator to guess (issue #337).
  expectRule(reviewOnly, /runtime/i, /refuses[^.!?]{0,40}finish/i, /reviewer turn/i);
  // The gate is on the dispatched turn, and the summary is not compared with the
  // reviewer result, so the prompt tells the orchestrator to record the status.
  expectRule(reviewOnly, /gate requires that a reviewer turn was dispatched/i);
  expectRule(reviewOnly, /does not compare the summary with the reviewer result/i);
  expectRule(
    reviewOnly,
    /record the reviewer status and verdict in verified/i,
    /error|missing report/i,
  );
  expectRule(reviewOnly, /Blockers/i, /open/i);
  // The mode-free prompt carries none of it, so an ordinary run is untouched.
  const noMode = initialPrompt({ task: "T", maxSteps: 10 });
  expect(noMode).not.toContain("This run is review-only");
  expect(reviewOnly).not.toBe(noMode);
  // A work-first or review-first run states its own mode and takes both gates.
  for (const mode of ["work-first", "review-first"]) {
    const prompt = initialPrompt({ task: "T", maxSteps: 10, mode, pr: 42, requireCi: 42 });
    expect(prompt).toContain(`This run is ${mode}`);
    expect(prompt).toContain("--require-ci 42");
  }
});

// Usefulness: verifies a run with no --mode keeps the origin/main prompt text
// byte for byte, so a run that never asked for a mode gets no changed prompt
// from this flag. The line is pinned verbatim because the PR promises it is
// unchanged (issue #337).
test("a run with no mode keeps the mode-free prompt", () => {
  expect(initialPrompt({ task: "T", maxSteps: 10 })).toContain(
    "- The loop policy (work-first, review-first, review-only ordering) is governed by the interactive agent-loop role mode. This headless loop chooses its own action order and still applies the completion rule above.",
  );
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
// the runtime supplies the status and the reviewer's own read is only a fallback.
// A gate-only run gets the same clauses for the gated PR (#320, #350).
test("the headless prompt adds the declaration rule and nothing else", () => {
  const block =
    "- This run declares PR #42. Finish it through --require-ci 42 for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed.";
  const supplied =
    " This run names PR #42, so the runtime reads the required-check status for that PR head and supplies it to every reviewer prompt. That status is advisory evidence, in place of the reviewer reading the checks: the reviewer reports it, keeps its own read as the fallback, and reads the checks itself when the supplied status is unresolved. The --require-ci finish gate re-reads GitHub and enforces the condition. The runtime reports the status it read beside the reviewer result, so compare it with the reviewer Checks line.";
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
  // The declared prompt carries the block, the supplied-read clause, and the
  // reworded gate line.
  expect(withPrAndGate.split("\n")).toContain(block);
  expect(withPrAndGate.split("\n").some((line) => line.startsWith(reworded))).toBe(true);
  expect(withPrAndGate).toContain(supplied.trim());
  // A gate-only run carries the same clauses, but no declaration block, because
  // the runtime reads the status for the gated PR too.
  expect(gated).not.toContain(block);
  expect(gated.split("\n").some((line) => line.startsWith(reworded))).toBe(true);
  expect(gated).toContain(supplied.trim());
  expect(gated).toContain(advisory);
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
    // A read of no page at all is unknown, and exactly one empty page is empty: two
    // different replies, and neither is a positive absence (#336 review).
    expectRule(text, /no page at all/i, /unknown/i);
    expectRule(text, /exactly one empty page/i, /empty/i, /positive absence/i);
    // An unlisted rule type settles nothing either.
    expectRule(text, /not a documented rule type/i, /unknown/i);
    // A rule on a later page is enforced rather than missed.
    expectRule(text, /paginated/i, /later page/i, /enforced/i);
  });

  // Usefulness: verifies ${name} states the four ruleset outcomes, so the empty
  // ruleset read is not described with the name of a reply that refuses (#336
  // review).
  test(`${name} states the four ruleset outcomes`, async () => {
    const text = await readFile(path, "utf8");
    // A read the gate cannot interpret refuses whatever the union holds.
    expectRule(text, /ruleset read the gate cannot interpret/i, /refuses the finish/i, /union/i);
    // Exactly one empty page is neither, so a classic-only repository still
    // finishes, and the anomalous page sequences are named as refusals.
    expectRule(text, /exactly one empty page/i, /contributes no contexts/i, /origin.main/i);
    expectRule(text, /no page at all/i, /two or more empty pages/i);
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
  // A copilot turn refuses `role wait-checks` but runs `gh pr checks` (#432 probe),
  // so a copilot orchestrator cannot wait and a copilot reviewer still reads (#495).
  expect(rule("copilot", "claude")).toBe("reviewer");
  expect(rule("copilot", "copilot")).toBe("reviewer");
  expect(rule("copilot", "codex")).toBe("gate");
  expect(rule("claude", "copilot")).toBe("wait");
  expect(rule("codex", "copilot")).toBe("reviewer");
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
  for (const kind of ["claude", "agy", "opencode"]) {
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

// Usefulness: verifies a copilot orchestrator is not told that its shell has no network or runs in
// a sandbox. Its read-only turn keeps network and only refuses `role wait-checks` (#432 probe,
// #495). The claude reviewer cases set up the reviewer rule. The codex and null reviewer cases set
// up the gate rule. Both rules tell it to run no check read itself.
test.each([
  ["claude", 42],
  ["claude", null],
  ["codex", 42],
  ["codex", null],
  [null, null],
])(
  "a copilot orchestrator with a %s reviewer, pr %s, keeps true limit wording",
  (reviewerKind, pr) => {
    const prompt = initialPrompt({
      task: "T",
      maxSteps: 10,
      requireCi: 42,
      orchestratorKind: "copilot",
      reviewerKind,
      pr,
    });
    const lines = prompt.split("\n");
    const from = lines.findIndex((line) => line.startsWith("- You orchestrate through copilot"));
    expect(from).toBeGreaterThanOrEqual(0);
    // The limit claim sits in the copilot bullet itself, so another role's text cannot satisfy it.
    const own = lines[from];
    expect(own).toContain("keeps shell network");
    expect(own).toContain("refuses agent-loop role wait-checks");
    expect(own).not.toMatch(/copilot, whose read-only turn cannot reach the network/);
    // The reviewer rule keeps the instruction in the bullet. The gate rule moves it two bullets on.
    const instruction = reviewerKind === "claude" ? own : lines[from + 2];
    expect(instruction).toContain("Do not run gh pr checks");
    expect(prompt).not.toMatch(/gh pr checks 42 --required|--watch/);
    expect(prompt).not.toMatch(/agent-loop role wait-checks --pr/);
  },
);

// Usefulness: verifies a copilot orchestrator in gate mode, in a gate-only run, is told both its
// true limit and the supplied read, and that only the gate enforces, so #495 and #350 do not
// contradict each other. Only the gate branch states the supplied read.
test.each([["codex"], [null]])(
  "a gate-only copilot orchestrator with a %s reviewer states its limit and the supplied read",
  (reviewerKind) => {
    const prompt = initialPrompt({
      task: "T",
      maxSteps: 10,
      requireCi: 42,
      orchestratorKind: "copilot",
      reviewerKind,
      pr: null,
    });
    const lines = prompt.split("\n");
    const from = lines.findIndex((line) => line.startsWith("- You orchestrate through copilot"));
    expect(from).toBeGreaterThanOrEqual(0);
    expect(lines[from]).toContain("refuses agent-loop role wait-checks without approval");
    // The supplied read follows the exception bullet, in the "Do not run gh pr checks" bullet.
    expect(lines[from + 2]).toContain("This run names PR #42");
    expect(lines[from + 2]).toContain("supplies it to every reviewer prompt");
    expect(prompt).toContain(
      "The advisory status read above reports to the reviewer and never enforces",
    );
  },
);

// Usefulness: verifies the reviewer mode for a copilot orchestrator states no supplied read,
// because only the gate branch states it.
test("a copilot orchestrator in reviewer mode states no supplied read", () => {
  const prompt = initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "copilot",
    reviewerKind: "claude",
    pr: null,
  });
  expect(prompt).not.toMatch(/supplies it to every reviewer prompt/);
});

// Usefulness: verifies the pending-check wait point keeps a pending check out of
// the finish summary, because the --require-ci gate refuses a finish while a
// required check is pending, so the run must wait, re-review, or abort (issue #319).
test("the pending-check wait point does not put a pending check in a finish summary", () => {
  for (const kind of ["claude", "agy", "opencode"]) {
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

// Usefulness: verifies the interactive instructions, the headless prompt, and the
// README state the status-read exception with the same scope: one command,
// `agent-loop role wait-checks`, so no text widens the role rule beyond what the
// others allow (issue #348).
test("instructions, prompt, and README share the status-read exception scope", async () => {
  const scope = "and agent-loop role wait-checks is the only command it covers";
  const flat = (text) => text.replace(/`/g, "").replace(/\s+/g, " ");
  const readme = await readFile(join(dirname(instructionsPath), "../README.md"), "utf8");
  expect(flat(await readFile(instructionsPath, "utf8"))).toContain(scope);
  expect(flat(gatedPrompt("claude"))).toContain(scope);
  expect(flat(readme)).toContain(scope);
  for (const text of [gatedPrompt("claude"), readme]) {
    expect(flat(text)).not.toMatch(/gh pr checks (?:and|or) [^.]*are the only commands/);
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

const WAIT_PREFIX = 'role wait-checks --cwd "/work tree"';
const WAIT_COMMAND = [
  { shell: "PowerShell", command: `& "/opt/node" "/opt/agent-loops/src/cli.mjs" ${WAIT_PREFIX}` },
  { shell: "bash or cmd", command: `"/opt/node" "/opt/agent-loops/src/cli.mjs" ${WAIT_PREFIX}` },
];
const waitPrompt = (timeout, extra = {}) =>
  initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout,
    waitCommand: WAIT_COMMAND,
    ...extra,
  });

// Usefulness: verifies the headless wait runs through the runtime-owned command
// with a stated bound below the turn timeout, and never through an unbounded
// `gh` watch, so a wait cannot end the run on the turn timeout (issue #348).
test.each([
  [undefined, 300],
  [null, 300],
  [3600, 300],
  [100, 45],
  [30, 10],
  [12, 1],
])("the headless wait states a bound below the turn timeout %s", (timeout, bound) => {
  const prompt = waitPrompt(timeout);
  for (const { command } of WAIT_COMMAND) {
    expect(prompt).toContain(`${command} --pr 42 --timeout ${bound}`);
  }
  expect(prompt).not.toContain("--watch");
  expect(prompt).not.toContain("few minutes");
  if (typeof timeout === "number") {
    expect(bound + 5).toBeLessThan(timeout);
  }
});

// Usefulness: verifies no turn timeout gets a wait that can outlast it: every
// timeout either gets a positive bound whose wait and five-second child-exit
// window end inside the turn, or gets no wait command at all (issue #348).
test("no turn timeout gets a wait that outlasts the turn", () => {
  for (let timeout = 1; timeout <= 700; timeout += 1) {
    const prompt = waitPrompt(timeout);
    const stated = prompt.match(/role wait-checks --cwd "[^"]*" --pr 42 --timeout (\d+)/);
    if (stated === null) {
      expect(timeout, "a turn that fits a wait names none").toBeLessThan(12);
      expect(prompt).toMatch(/cannot wait for the required checks/i);
      expect(prompt).toMatch(/do not run agent-loop role wait-checks/i);
      continue;
    }
    const bound = Number(stated[1]);
    expect(bound).toBeGreaterThanOrEqual(1);
    expect(bound + 5).toBeLessThan(timeout);
  }
});

// Usefulness: verifies a run whose turn is too short for any wait tells the
// orchestrator to rely on the gate instead of running a wait that ends the run
// (issue #348).
test.each([1, 2, 5, 10, 11])("a %s second turn names no wait", (timeout) => {
  const prompt = waitPrompt(timeout);
  expect(prompt).not.toContain("--pr 42 --timeout");
  expect(prompt).not.toContain("Wait for the required checks at two points");
  expect(prompt).toMatch(/too short/i);
  expect(prompt).toMatch(/abort with the pending check/i);
});

// Usefulness: verifies the ADR 0010 child-exit rule reaches the headless
// orchestrator, so an unobserved exit is not read as a clean machine (issue #348).
test("the headless wait states the childExitUnconfirmed rule", () => {
  const prompt = waitPrompt(3600).replace(/\s+/g, " ");
  expect(prompt).toMatch(/"childExitUnconfirmed": true[^.]*unaccounted/i);
  expect(prompt).toMatch(/settle that process before you start another wait/i);
});

// Usefulness: verifies the platform decides the shell forms: a Windows run gets
// a PowerShell form with the call operator and a bash-or-cmd form without it,
// and any other platform gets one plain form (issue #348).
test("the wait command renders the shell forms of the platform", () => {
  const input = {
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "D:\\a b\\cli.mjs",
    cwd: "E:\\work tree",
  };
  const plain = '"C:/Program Files/nodejs/node.exe" "D:/a b/cli.mjs" role wait-checks --cwd "';
  const win = waitChecksCommand({ ...input, platform: "win32" });
  expect(win.map((form) => form.shell)).toEqual(["PowerShell", "bash or cmd"]);
  expect(win[0].command.startsWith(`& ${plain}`)).toBe(true);
  expect(win[1].command.startsWith(plain)).toBe(true);
  expect(win[1].command.endsWith('work tree"')).toBe(true);

  const posix = waitChecksCommand({
    execPath: "/opt/node",
    cliPath: "/opt/a b/cli.mjs",
    cwd: "/srv/work tree",
    platform: "linux",
  });
  expect(posix).toEqual([
    {
      shell: "sh",
      command: `"/opt/node" "/opt/a b/cli.mjs" role wait-checks --cwd "/srv/work tree"`,
    },
  ]);
});

// Usefulness: verifies the command carries the run's resolved work tree, so the
// wait reads the right repository whatever directory the shell starts in, and the
// prompt passes the run's `cwd` through (issue #348).
test("the wait command and the prompt carry the resolved work tree", () => {
  const forms = waitChecksCommand({ cwd: "relative/tree" });
  expect(forms[0].command).toContain(`--cwd "${resolve("relative/tree").replaceAll("\\", "/")}"`);
  const prompt = initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout: 3600,
    cwd: "/srv/run tree",
  });
  expect(prompt).toContain(`--cwd "${resolve("/srv/run tree").replaceAll("\\", "/")}" --pr 42`);
});

// Every character that bash, PowerShell, or cmd expands or reinterprets inside a
// double-quoted argument. ADR 0013 lists the same set.
const UNSAFE_CHARACTERS = [
  ['"', "double quote"],
  ["$", "dollar"],
  ["`", "backtick"],
  ["%", "percent (cmd)"],
  ["!", "exclamation (cmd delayed expansion, bash history)"],
  ["\u201C", "left double quotation mark (PowerShell quote)"],
  ["\u201D", "right double quotation mark (PowerShell quote)"],
  ["\u201E", "low double quotation mark (PowerShell quote)"],
  ["\n", "line feed"],
  ["\r", "carriage return"],
  ["\t", "tab"],
  ["\u0000", "NUL"],
];

// Usefulness: verifies a Node path, a CLI path, or a work tree path that holds a
// character a shell expands inside double quotes gets no command, so the prompt
// never renders a command that runs something else (issue #348).
test.each(UNSAFE_CHARACTERS)("the wait command refuses a path holding %j (%s)", (char) => {
  const safe = { execPath: "/opt/node", cliPath: "/opt/cli.mjs", cwd: "/srv/tree" };
  expect(waitChecksCommand({ ...safe, platform: "linux" })).not.toBeNull();
  for (const key of ["execPath", "cliPath", "cwd"]) {
    const input = { ...safe, [key]: `${safe[key]}${char}x`, platform: "linux" };
    expect(waitChecksCommand(input), key).toBeNull();
    expect(waitChecksCommand({ ...input, platform: "win32" }), key).toBeNull();
  }
});

// Usefulness: verifies a POSIX path keeps its backslashes or is refused, never
// rewritten: a POSIX backslash is a name character, so a slash in its place would
// point the command at another path. The slash rewrite stays Windows-only
// (issue #348).
test("a POSIX path is never rewritten and a backslash in it is refused", () => {
  const safe = { execPath: "/opt/node", cliPath: "/opt/cli.mjs", cwd: "/srv/tree" };
  const rendered = waitChecksCommand({ ...safe, platform: "linux" });
  expect(rendered[0].command).toBe('"/opt/node" "/opt/cli.mjs" role wait-checks --cwd "/srv/tree"');
  for (const key of ["execPath", "cliPath", "cwd"]) {
    const input = { ...safe, [key]: `${safe[key]}/dir\\name`, platform: "linux" };
    expect(waitChecksCommand(input), key).toBeNull();
  }
  // The same character is a separator on Windows and becomes a slash there.
  const win = waitChecksCommand({
    execPath: "C:\\node\\node.exe",
    cliPath: "C:\\repo\\cli.mjs",
    cwd: "C:\\repo",
    platform: "win32",
  });
  expect(win[1].command).toBe(
    '"C:/node/node.exe" "C:/repo/cli.mjs" role wait-checks --cwd "C:/repo"',
  );
});

// Usefulness: verifies the README architecture section states the same
// status-read exception as the prompt, `agent-loop role wait-checks` only, so no
// text keeps the older rule that allowed `gh pr checks` (issue #348).
test("the README architecture rule names role wait-checks as the only exception command", async () => {
  const readme = await readFile(join(dirname(instructionsPath), "../README.md"), "utf8");
  const rule = readme.split("\n").find((line) => line.startsWith("- **Orchestrator**"));
  expect(rule).toContain(
    "read the pull request check status with `agent-loop role wait-checks`, and that status read is the only command the exception covers",
  );
  expect(rule).not.toContain("gh pr checks");
});

// Usefulness: verifies a run with no renderable command names no wait, and says
// why, instead of a wait command the shell would misread (issue #348).
test("a run with no renderable command names no wait", () => {
  const prompt = waitPrompt(3600, { waitCommand: null });
  expect(prompt).not.toContain("--pr 42 --timeout");
  expect(prompt).toMatch(/cannot wait for the required checks/i);
  expect(prompt).toMatch(/work tree that every shell reads the same way/i);
});

const isWindows = process.platform === "win32";

// Resolves true when `command` starts, whatever its exit code.
async function canRun(command, args) {
  const run = await execa(command, args, { reject: false });
  return !run.failed || run.exitCode !== undefined;
}
const hasBash = await canRun("bash", ["-c", "exit 0"]);
const hasPowerShell =
  isWindows && (await canRun("powershell", ["-NoProfile", "-Command", "exit 0"]));

// Runs one rendered form in a real shell and returns the combined output. The
// script goes through a file so the shell parses exactly the text the prompt
// carries. No --pr is given, so the CLI refuses before it reads anything.
async function runForm(shell, command, dir) {
  if (shell === "bash") {
    return execa("bash", ["-c", command], { reject: false, all: true });
  }
  if (shell === "powershell") {
    const script = join(dir, "form.ps1");
    await writeFile(script, `${command}\n`);
    return execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      reject: false,
      all: true,
    });
  }
  const script = join(dir, "form.cmd");
  await writeFile(script, `@echo off\r\n${command}\r\n`);
  return execa("cmd", ["/d", "/c", script], { reject: false, all: true });
}

// Usefulness: verifies each rendered form starts the CLI in a real shell, with a
// Node path and a work tree path that hold spaces, since a form that a shell
// rejects would leave the orchestrator with no wait. PowerShell needs the call
// operator and bash and cmd reject it (issue #348).
describe("the rendered wait forms run in a real shell", () => {
  const withDir = async (run) => {
    const dir = await mkdtemp(join(tmpdir(), "wait form "));
    try {
      const scripts = await mkdtemp(join(tmpdir(), "waitform-"));
      try {
        return await run(dir, scripts);
      } finally {
        await rm(scripts, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const REFUSED = /wait-checks requires --pr/;

  test.skipIf(isWindows || !hasBash)("the sh form runs in bash", async () => {
    await withDir(async (cwd, scripts) => {
      const [form] = waitChecksCommand({ cwd });
      const run = await runForm("bash", form.command, scripts);
      expect(run.all).toMatch(REFUSED);
    });
  });

  test.skipIf(!isWindows || !hasBash)("the bash-or-cmd form runs in bash", async () => {
    await withDir(async (cwd, scripts) => {
      const form = waitChecksCommand({ cwd }).find((f) => f.shell === "bash or cmd");
      const run = await runForm("bash", form.command, scripts);
      expect(run.all).toMatch(REFUSED);
    });
  });

  test.skipIf(!isWindows)(
    "the bash-or-cmd form runs in cmd, and the call operator does not",
    async () => {
      await withDir(async (cwd, scripts) => {
        const forms = waitChecksCommand({ cwd });
        const plain = forms.find((f) => f.shell === "bash or cmd");
        const ok = await runForm("cmd", plain.command, scripts);
        expect(ok.all).toMatch(REFUSED);
        const rejected = await runForm(
          "cmd",
          forms.find((f) => f.shell === "PowerShell").command,
          scripts,
        );
        expect(rejected.all).not.toMatch(REFUSED);
      });
    },
  );

  test.skipIf(!hasPowerShell)(
    "the PowerShell form runs in PowerShell, and the plain form does not",
    async () => {
      await withDir(async (cwd, scripts) => {
        const forms = waitChecksCommand({ cwd });
        const ok = await runForm(
          "powershell",
          forms.find((f) => f.shell === "PowerShell").command,
          scripts,
        );
        expect(ok.all).toMatch(REFUSED);
        const rejected = await runForm(
          "powershell",
          forms.find((f) => f.shell === "bash or cmd").command,
          scripts,
        );
        expect(rejected.all).not.toMatch(REFUSED);
      });
    },
  );
});

// Usefulness: verifies the default prompt names a command built from this
// install, not a bare `agent-loop` that a clone run has no PATH entry for: the
// rendered Node binary and CLI script exist (issue #348).
test("the default wait command names the Node binary and CLI script of this run", async () => {
  const prompt = initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout: 3600,
  });
  const match = prompt.match(
    /"([^"]+)" "([^"]+)" role wait-checks --cwd "[^"]+" --pr 42 --timeout 300/,
  );
  expect(match).not.toBeNull();
  const [, node, cli] = match;
  expect(node).toBe(process.execPath.replaceAll("\\", "/"));
  expect(prompt).not.toMatch(/agent-loop role wait-checks --pr/);
  await access(cli);
});

// Usefulness: verifies the prompt names the timeout outcome: a wait that reached
// its bound is a completed read that leaves the check pending, so the run acts on
// it inside the turn instead of waiting again (issue #348).
test("the headless wait names the timedOut outcome as a pending check", () => {
  const prompt = gatedPrompt("claude").replace(/\s+/g, " ");
  expect(prompt).toMatch(/"timedOut": true[^.]*pending/i);
  expect(prompt).toMatch(/do not wait again in the same turn/i);
});

// Usefulness: verifies the status-read exception covers the wait command as well
// as `gh pr checks`, so the bounded wait is inside the role rule (issue #348).
test("the status-read exception covers the wait-checks command", () => {
  const exception = gatedPrompt("claude")
    .split("\n")
    .find((line) => /excepts one read/i.test(line));
  expect(exception).toMatch(/wait-checks/);
});

// Usefulness: verifies the headless prompt forbids a remote write and keeps the
// `role wait-checks` status read allowed as not a write, so the rule never blocks
// the bounded wait (issue #422).
test("the headless prompt forbids a remote write and keeps the wait-checks read allowed", () => {
  const prompt = gatedPrompt("claude").replace(/\s+/g, " ");
  expect(prompt).toContain("You must NOT write to GitHub or any remote");
  expect(prompt).toContain(
    "A status read changes nothing, so it is not a write, and agent-loop role wait-checks stays allowed",
  );
  expect(prompt).toContain(
    "not an edit, and not a remote write, and agent-loop role wait-checks is the only command it covers",
  );
  expect(prompt).toMatch(/role wait-checks --cwd/);
  expect(prompt).not.toMatch(/do not run agent-loop role wait-checks/i);
});

// Usefulness: verifies a run with no PR gate carries the rule too (issue #422).
test("the headless prompt forbids a remote write without a PR gate", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expect(prompt).toContain("You must NOT write to GitHub or any remote");
});

// Usefulness: verifies the interactive instructions state the same remote-write
// rule and the same status-read carve-out as the headless prompt (issue #422).
test("the interactive instructions forbid a remote write and allow a status read", async () => {
  const text = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  expect(text).toContain("Never write to GitHub or any remote");
  expect(text).toContain(
    "A status read, such as `agent-loop role wait-checks`, changes nothing, so it is not a write.",
  );
});

// Usefulness: verifies the README states that the runtime does not see a remote
// write, names both paths, and says the connector write was not probed (issue #422).
test("the README states the remote-write limit", async () => {
  const readme = (await readFile(join(dirname(instructionsPath), "../README.md"), "utf8")).replace(
    /\s+/g,
    " ",
  );
  expect(readme).toContain(
    "the runtime does not detect a remote write in a reviewer or orchestrator turn",
  );
  expect(readme).toContain("Shell network.");
  expect(readme).toContain("`codex_apps`");
  expect(readme).toContain("A write through those tools was not probed");
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

// Usefulness: verifies a gate-only run states the supplied status for the gated PR,
// because the runtime reads it there and a sandboxed reviewer cannot (issue #350).
test("a gate-only run states the supplied status for the gated PR", () => {
  expect(gatedPrompt("codex", "codex")).toMatch(/names PR #42.*supplies it to every reviewer/i);
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
  // The commit binding is stated once, so the two surfaces cannot drift into two
  // versions of the same statement (issue #349).
  const bound = instructions.match(/check runs and commit statuses by SHA, every page of each/g);
  expect(bound).toHaveLength(1);
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

// Usefulness: verifies a run with no PR and no gate is not told the runtime supplied
// a status read, because the runtime makes no read there, so the prompt would
// describe a read that never happens (issues #320, #350).
test("a run with no PR and no gate claims no supplied status read", () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    orchestratorKind: "codex",
    reviewerKind: "codex",
  });
  expect(prompt).not.toMatch(/supplies it to every reviewer prompt/);
  expect(prompt).not.toMatch(/advisory status read/);
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

// Usefulness: a continued run tells the orchestrator that its budget is new and
// that no reviewer accept carries over, and a fresh run's prompt states neither (#362).
describe("continued run prompt", () => {
  const base = { task: "t", maxSteps: 3 };

  test("states the reset only when the run is continued", () => {
    expect(initialPrompt({ ...base, continued: true })).toContain(
      "The runtime carries over no reviewer accept",
    );
    expect(initialPrompt(base)).not.toContain("continues an earlier run");
    expect(initialPrompt({ ...base, continued: false })).toBe(initialPrompt(base));
  });

  // Usefulness: a restored gate must not be described as a reset, or the orchestrator would
  // dispatch a reviewer the runtime no longer requires (#393).
  test("states the restore instead of the reset when the gate was restored", () => {
    const prompt = initialPrompt({ ...base, continued: true, gateRestored: true });
    expect(prompt).toContain("restored that run's completion gate state");
    expect(prompt).not.toContain("carries over no reviewer accept");
  });
});

// Usefulness: verifies the headless orchestrator sees the test result beside the
// reviewer response, and a worker result carries none, so the comparison with the
// reviewer Checks line has both in one prompt (issue #420, ADR 0017).
test("the result prompt carries the runtime-run test result only when the result has one", () => {
  const withRun = resultPrompt({
    result: {
      role: "reviewer",
      status: "ok",
      response: "Verdict: accept",
      testRun: { status: "fail", exitCode: 1, advisory: true },
    },
    stepsUsed: 1,
    maxSteps: 5,
  });
  expect(withRun).toMatch(/"testRun"/);
  expect(withRun).toMatch(/"exitCode": 1/);
  const without = resultPrompt({
    result: { role: "worker", status: "ok", response: "done" },
    stepsUsed: 1,
    maxSteps: 5,
  });
  expect(without).not.toMatch(/testRun/);
});

// Usefulness: verifies the initial prompt names the test command only for a run
// that has one, and a run without the flag keeps its prompt, so the prompt never
// describes a result that will not arrive (issue #420).
test("the initial prompt describes the test command only when the run has one", () => {
  const base = { task: "t", maxSteps: 5 };
  expect(initialPrompt(base)).toBe(initialPrompt({ ...base, testCmd: false }));
  expect(initialPrompt(base)).not.toContain("--test-cmd");
  const prompt = initialPrompt({ ...base, testCmd: true });
  expect(prompt).toContain("This run has a test command (--test-cmd).");
  expect(prompt).toContain("A status of timed-out is neither a pass nor a failure.");
});

// Usefulness: verifies the initial prompt tells the orchestrator about the opt-in reviewer sandbox
// only for a run that set it, and says the reviewer still never edits, so the prompt never
// describes a sandbox that the run does not have (issue #421).
test("the initial prompt describes the reviewer sandbox only when the run opted in", () => {
  const base = { task: "t", maxSteps: 5 };
  expect(initialPrompt(base)).toBe(initialPrompt({ ...base, reviewerWorkspaceWrite: false }));
  expect(initialPrompt(base)).not.toContain("workspace-write");
  const prompt = initialPrompt({ ...base, reviewerWorkspaceWrite: true });
  expect(prompt).toContain("workspace-write");
  expect(prompt).toContain("network access off");
  expect(prompt).toContain("halts the run");
});

// Documentation of the opt-in Codex reviewer sandbox (issue #421, ADR 0019). Each test asserts
// the content a reader relies on, as a short phrase, so a same-meaning reword passes.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const adr19 = "adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md";
const readRepoFile = (path) => readFile(join(repoRoot, path), "utf8");

// The five accepted gaps of issue #421, each as the phrases that identify it.
const SANDBOX_GAPS = [
  ["detection-only enforcement", [/detective/i, /MutationError/, /no revert|does not revert/i]],
  [
    "snapshot blind spots",
    [/ignored file/i, /outside the repository/i, /restores? before/i, /other refs/i],
  ],
  ["remote GitHub writes", [/remote/i, /push.*merge.*review.*comment/i, /#422/]],
  ["prompt-injection blast radius", [/prompt-injection/i]],
  ["unelevated Windows sandbox", [/unelevated Windows/i, /EPERM/, /docs\/parent-guard\.md/]],
];

// Usefulness: verifies ADR 0019 names all five accepted gaps of the issue, so the record of what
// the opt-in gives up cannot lose one.
test("ADR 0019 names the five accepted gaps", async () => {
  const text = await readRepoFile(adr19);
  for (const [, patterns] of SANDBOX_GAPS) {
    for (const pattern of patterns) {
      expect(text).toMatch(pattern);
    }
  }
});

// Usefulness: verifies the README and the orchestrator instructions describe the opt-in with the
// ADR: the flag, the sandbox mode, the network option, the ADR, and each gap.
test.each([
  ["README.md", "README.md"],
  ["docs/orchestrator-instructions.md", "docs/orchestrator-instructions.md"],
])("%s describes the reviewer sandbox opt-in consistently with ADR 0019", async (_name, path) => {
  const text = await readRepoFile(path);
  expect(text).toContain("--reviewer-workspace-write");
  expect(text).toContain("workspace-write");
  expect(text).toContain("network_access=false");
  expect(text).toMatch(/ADR 0019/);
  expect(text).toMatch(/detect/i);
  expect(text).toMatch(/ignored file/i);
  expect(text).toMatch(/remote state/i);
  expect(text).toMatch(/instruction/i);
  expect(text).toMatch(/unelevated Windows/i);
});

// Usefulness: verifies every surface that states the network limit says what it covers, shell
// commands that the sandbox runs, and does not claim it blocks model-side tools such as
// web_search, so a reader never takes the limit for a block on every channel.
test.each([
  ["README.md", () => readRepoFile("README.md")],
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
  ["ADR 0019", () => readRepoFile(adr19)],
  ["--help", async () => (await execa("node", [join(repoRoot, "src/cli.mjs"), "--help"])).stdout],
  ["reviewer prompt", async () => reviewerPrompt("x", null, null, true)],
  [
    "orchestrator prompt",
    async () => initialPrompt({ task: "t", maxSteps: 5, reviewerWorkspaceWrite: true }),
  ],
])("%s qualifies the sandbox network limit as shell commands only", async (_name, load) => {
  const text = await load();
  expect(text).toMatch(/shell commands/i);
  expect(text).toMatch(/model-side tools?|web_search|web search/i);
});

// Usefulness: verifies ADR 0019 supersedes ADR 0001 in both directions and in the index, and
// restates the decisions of ADR 0001 that still hold, so no live decision is lost.
test("ADR 0019 supersedes ADR 0001 and restates what still holds", async () => {
  const adr1 = await readRepoFile("adr/0001-hybrid-orchestrator-runtime.md");
  const text = await readRepoFile(adr19);
  const index = await readRepoFile("adr/README.md");
  expect(adr1).toMatch(/## Status\s+superseded/);
  expect(adr1).toMatch(/Superseded by \[ADR 0019[^\]]*\]\(0019-/);
  expect(text).toMatch(/## Status\s+accepted/);
  expect(text).toMatch(/Supersedes \[ADR 0001[^\]]*\]\(0001-hybrid-orchestrator-runtime\.md\)/);
  // The parts of ADR 0001 that still hold.
  expect(text).toMatch(/read-only by default/i);
  expect(text).toMatch(/orchestrator[^.]*read-only/i);
  expect(text).toMatch(/two-layer/i);
  expect(text).toMatch(/run_worker/);
  expect(text).toMatch(/--max-steps/);
  expect(text).toMatch(/one repair turn/i);
  expect(text).toMatch(/changed, verified, deferred, notDone, open|`changed`, `verified`/);
  const row = (n) => index.split("\n").find((line) => line.includes(`[${n}](`));
  expect(row("0001")).toMatch(/\|\s*superseded\s*\|/);
  expect(row("0001")).toMatch(/ADR 0019/);
  expect(row("0019")).toMatch(/\|\s*accepted\s*\|/);
  expect(row("0019")).toMatch(/Supersedes ADR 0001/);
});

// A sentence that denies network, GitHub, or a check read to a turn must say that the limit
// covers shell commands, in the sentence or in the one after it, so a reader never takes the
// Codex sandbox for a block on a model-side tool or another channel. The positive-phrase tests
// above cannot catch a contradicting sentence, so this scan reads every sentence of every surface
// that states such a limit (issue #421, ADR 0019). A denial is a negation near network, GitHub, or
// the required checks: `cannot reach ... network`, `no turn can read the checks`, `blocks
// network`, `cannot run gh`, `with no network access`.
const NETWORK_DENIAL = new RegExp(
  [
    String.raw`\b(cannot|can not|unable to|never)\b[^.;:]*\b(reach|read|run|connect|wait)\b[^.;:]*(network|GitHub|\bgh\b|credential)`,
    String.raw`\bno turn\b[^.;:]*\bcan\b[^.;:]*\b(read|reach)\b`,
    String.raw`\bblocks?\b[^.;:]*network`,
    String.raw`\b(no|without|off)\s+(\w+\s+)?network\b`,
    String.raw`\bnetwork( access)?\s+(is |stays )?off\b`,
    String.raw`cannot either`,
  ].join("|"),
  "i",
);
const sentencesOf = (text) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.:;])\s+(?=[A-Z`-])|\s\|\s/)
    .map((sentence) => sentence.trim());

function unqualifiedDenials(text) {
  const sentences = sentencesOf(text);
  return sentences.filter(
    (sentence, i) =>
      NETWORK_DENIAL.test(sentence) && !/shell/i.test(`${sentence} ${sentences[i + 1] ?? ""}`),
  );
}

const gated = (extra) => initialPrompt({ task: "t", maxSteps: 5, requireCi: 42, ...extra });

// Usefulness: verifies no denial of network or of a check read stays unqualified in the rendered
// orchestrator prompt, for the default run and the opted-in run, for every gate rule, with and
// without a declared PR, so the prompt never overstates what the Codex sandbox isolates.
describe.each([
  ["default", false],
  ["opted-in", true],
])("the %s orchestrator prompt qualifies every network denial", (_name, reviewerWorkspaceWrite) => {
  test.each([
    ["codex", "codex", null],
    ["codex", "codex", 42],
    ["codex", "claude", null],
    ["codex", "claude", 42],
    ["copilot", "claude", 42],
    ["copilot", "codex", null],
    ["copilot", "codex", 42],
    ["claude", "codex", null],
    ["claude", "claude", 42],
    [null, null, null],
  ])("%s orchestrator, %s reviewer, pr %s", (orchestratorKind, reviewerKind, pr) => {
    const prompt = gated({ orchestratorKind, reviewerKind, pr, reviewerWorkspaceWrite });
    expect(unqualifiedDenials(prompt)).toEqual([]);
  });

  test("the ungated prompt", () => {
    expect(
      unqualifiedDenials(initialPrompt({ task: "t", maxSteps: 5, reviewerWorkspaceWrite })),
    ).toEqual([]);
  });
});

// Usefulness: verifies the scan finds the denial wordings it exists for, so a pass means the
// surfaces are clean and not that the detector is blind.
test("the network denial scan flags an unqualified denial and accepts a qualified one", () => {
  for (const bad of [
    "The orchestrator cannot reach a credential or a network itself.",
    "- You orchestrate through codex, whose read-only turn cannot reach the network, so no turn in this run can read the required checks.",
    "The sandbox blocks network access.",
    "A Codex reviewer turn cannot run `gh` either.",
    "Both CLIs block network: no turn in the run can read the required checks.",
  ]) {
    expect(unqualifiedDenials(bad), bad).toHaveLength(1);
  }
  expect(
    unqualifiedDenials(
      "Its shell commands cannot reach the network. That limit covers shell commands only.",
    ),
  ).toEqual([]);
});

// A user execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception to the Codex
// shell network limit. Such a rule ran a shell command outside the sandbox, with network (issue
// #640). The runtime does not prevent that (issue #655). Every runtime prompt sentence that denies
// shell network must carry this exact exception text, within six sentences after the denial.
const USER_RULE_EXCEPTION =
  "A user Codex execpolicy rule that allows `bash -c`, `sh -c`, or `zsh -c` is an exception. That rule can run a shell command with an expansion outside the sandbox, with network. The runtime does not prevent that.";
function denialsWithoutUserRuleException(text) {
  const sentences = sentencesOf(text);
  return sentences.filter(
    (sentence, i) =>
      NETWORK_DENIAL.test(sentence) &&
      !sentences
        .slice(i, i + 6)
        .join(" ")
        .includes(USER_RULE_EXCEPTION),
  );
}

// Usefulness: verifies that the rendered orchestrator prompts and the opted-in reviewer prompt
// carry the user-rule exception after a shell network denial. No role then treats a shell network
// result as impossible (issue #655). The qualification scan above does not check the exception.
describe.each([
  ["default", false],
  ["opted-in", true],
])("the %s runtime prompts state the user-rule exception", (_name, reviewerWorkspaceWrite) => {
  test.each([
    ["codex", "codex", null],
    ["codex", "codex", 42],
    ["codex", "claude", 42],
    ["copilot", "codex", 42],
    ["claude", "codex", null],
    [null, null, null],
  ])("%s orchestrator, %s reviewer, pr %s", (orchestratorKind, reviewerKind, pr) => {
    const prompt = gated({ orchestratorKind, reviewerKind, pr, reviewerWorkspaceWrite });
    expect(denialsWithoutUserRuleException(prompt)).toEqual([]);
  });

  test("the ungated prompt", () => {
    expect(
      denialsWithoutUserRuleException(
        initialPrompt({ task: "t", maxSteps: 5, reviewerWorkspaceWrite }),
      ),
    ).toEqual([]);
  });
});

// Usefulness: verifies that the opted-in reviewer prompt carries the exact user-rule exception
// text (issue #655).
test("the opted-in reviewer prompt states the user-rule exception", () => {
  expect(denialsWithoutUserRuleException(reviewerPrompt("x", null, null, true))).toEqual([]);
  expect(reviewerPrompt("x", null, null, true).replace(/\s+/g, " ")).toContain(USER_RULE_EXCEPTION);
});

// Usefulness: verifies that the exception scan flags a denial with no exception or with a contrary
// one. A pass then means the prompts are clean, not that the detector is blind.
test("the exception scan flags a denial without the user-rule exception", () => {
  expect(
    denialsWithoutUserRuleException("The shell commands that you run have no network access."),
  ).toHaveLength(1);
  expect(
    denialsWithoutUserRuleException(
      `The shell commands have no network access. ${USER_RULE_EXCEPTION}`,
    ),
  ).toEqual([]);
  expect(
    denialsWithoutUserRuleException(
      "The shell commands have no network access. A user Codex execpolicy rule is never an exception.",
    ),
  ).toHaveLength(1);
});

// Usefulness: verifies the reviewer prompt, the README, the orchestrator instructions, the other
// docs, the help text, and ADR 0019 carry no unqualified denial, so the prompt and the docs state
// one rule about what the Codex sandbox blocks.
test.each([
  ["README.md", () => readRepoFile("README.md")],
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
  ["docs/parent-guard.md", () => readRepoFile("docs/parent-guard.md")],
  ["ADR 0019", () => readRepoFile(adr19)],
  ["--help", async () => (await execa("node", [join(repoRoot, "src/cli.mjs"), "--help"])).stdout],
  ["default reviewer prompt", async () => reviewerPrompt("x", null, null, false)],
  ["opted-in reviewer prompt", async () => reviewerPrompt("x", null, null, true)],
])("%s qualifies every network denial", async (_name, load) => {
  expect(unqualifiedDenials(await load())).toEqual([]);
});
