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

// A prompt rule is asserted as the terms one statement carries, never as a whole
// prompt sentence, so a same-meaning reword keeps the assertion and a changed
// rule breaks it. A statement is a sentence, a clause inside it, or an action
// with the conditions it governs, and each predicate below picks the shape the
// rule needs. Every split needs a mark plus whitespace, so a period inside
// `reviewed.head` does not end a sentence.

/** The sentences of a prompt or instruction text, whitespace collapsed. */
const sentences = (text) => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);

/** The clauses of a text: its sentences, then the list items inside them. */
const clauses = (text) => text.replace(/\s+/g, " ").split(/[.;]\s+/);

// A negation that governs an action next to it. A bare "no" is left out, because
// "no network access" and "no reviewer turn" are conditions, not prohibitions,
// and so is "non-empty".
const NEGATION =
  /\b(?:do not|do n't|does not|does n't|did not|don't|doesn't|didn't|never|not|without|cannot|can't|must not|may not|refuse[sd]?|refusing)\b/i;

// How far a term may sit from the one before it in an ordered rule.
const ORDER_GAP = 40;

// Each match of an action, with the text close by and the wider text around it,
// so a condition counts only when it sits with the action it governs.
function spans(sentence, action) {
  const global = new RegExp(action.source, action.flags.replace("g", "") + "g");
  return [...sentence.matchAll(global)].map((match) => ({
    near: sentence.slice(Math.max(0, match.index - 25), match.index + match[0].length + 25),
    wide: sentence.slice(Math.max(0, match.index - 160), match.index + match[0].length + 160),
  }));
}

// A presence rule: one sentence carries every term.
function expectRule(text, ...terms) {
  const stated = sentences(text).some((sentence) => terms.every((term) => term.test(sentence)));
  expect(stated, `no sentence carries ${terms.map(String).join(" ")}`).toBe(true);
}

// A clause rule: one clause carries every term, so moving a term into another
// clause, or swapping what a clause carries, fails.
function expectClause(text, ...terms) {
  const stated = clauses(text).some((clause) => terms.every((term) => term.test(clause)));
  expect(stated, `no clause carries ${terms.map(String).join(" ")}`).toBe(true);
}

// An action rule: one sentence binds the action to every condition, so removing
// the action, removing a condition, or changing what the action produces fails.
function expectAction(text, action, ...conditions) {
  const stated = sentences(text).some((sentence) =>
    spans(sentence, action).some((span) => conditions.every((term) => term.test(span.wide))),
  );
  expect(stated, `no sentence binds ${action} to ${conditions.map(String).join(" ")}`).toBe(true);
}

// A prohibition rule: the same binding, plus a negation close to the action, so
// the same rule read the other way, "finish" for "do not finish", fails.
function expectProhibition(text, action, ...conditions) {
  const stated = sentences(text).some((sentence) =>
    spans(sentence, action).some(
      (span) => NEGATION.test(span.near) && conditions.every((term) => term.test(span.wide)),
    ),
  );
  expect(stated, `no sentence negates ${action} for ${conditions.map(String).join(" ")}`).toBe(
    true,
  );
}

// An ordered rule: one clause carries the terms in this order, each within one
// gap of the last, so a subject that maps to a different target fails while a
// reword of either side keeps them close.
function expectOrder(text, ...terms) {
  const stated = clauses(text).some((clause) => {
    let at = 0;
    for (const term of terms) {
      const found = new RegExp(term.source, term.flags).exec(clause.slice(at, at + ORDER_GAP));
      if (!found) return false;
      at += found.index + found[0].length;
    }
    return true;
  });
  expect(stated, `no clause carries ${terms.map(String).join(" then ")}`).toBe(true);
}

// Usefulness: verifies initialPrompt states the role, the step budget, the task
// it completes, and the action format it answers with, so a headless turn runs
// the loop instead of answering prose (issue #328).
test("initialPrompt produces expected orchestrator prompt", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, /orchestrator/i, /automated/i, /\bagent/i, /\bloop\b/i);
  expectAction(prompt, /step budget/i, /\b10 steps\b/i);
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
  expectClause(prompt, /conclusion/i, /\bwhy\b/i, /\bblockers\b/i, /required/i);
  expectClause(prompt, /\bchecks\b/i, /\bnotes\b/i, /\bdeferred\b/i, /optional/i);
  // A deferred item is carried forward, leaves the list only on a later worker
  // turn and a later reviewer accept, and lands in changed when it does.
  expectClause(prompt, /\bdeferred\b/i, /forward/i, /\bcarry\b/i);
  expectAction(prompt, /record[^.!?]{0,40}changed/i, /worker/i, /\baccept\b/i);
  expectOrder(prompt, /\bitem/i, /\bfinish\b/i, /go into deferred/i);
  // A reviewer note no later turn addressed lands in open, and a change made for
  // a note goes through the worker and a further reviewer accept before finish.
  expectOrder(prompt, /note/i, /address/i, /\bopen\b/i);
  expectProhibition(
    prompt,
    /(?:send|hand|pass|give|forward)[^.!?]{0,24}note/i,
    /automatic|by itself|on its own|unasked/i,
  );
  expectAction(
    prompt,
    /dispatch[^.!?]{0,40}worker/i,
    /note/i,
    /\baccept\b/i,
    /new state/i,
    /\bfinish\b/i,
  );
  // In review-only mode, Blockers and Notes go to open, and reviewer Deferred
  // items go to deferred, which holds out-of-scope items in every mode while
  // open holds unresolved in-scope findings.
  expectOrder(prompt, /review-only/i, /\bblockers\b/i, /note/i, /go into open/i);
  expectAction(prompt, /go into deferred/i, /reviewer/i, /\bdeferred\b/i);
  expectClause(prompt, /\bdeferred\b/i, /out-of-scope/i, /every mode/i);
  expectClause(prompt, /\bopen\b/i, /unresolved/i, /in-scope/i);
});

// Usefulness: verifies the headless parent names the guards and contracts at risk
// in a reviewer prompt and does not restate the spec as the pass condition,
// matching the interactive reviewer-prompt rule (issue #228, issue #328).
test("initialPrompt states the reviewer-prompt guard and contract rule", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectAction(prompt, /name[^.!?]{0,60}guards/i, /reviewer/i, /at risk/i, /trace/i);
  expectProhibition(prompt, /restate[^.!?]{0,20}spec/i, /pass condition/i);
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
// as the interactive instructions: compare head, require clean, treat an accept
// without a Checks line as not accepted, and never finish as verified on an
// unresolved compare (issue #217, issue #328).
test("initialPrompt states the reviewed-state parent rules", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectAction(prompt, /compare/i, /reviewed\.head/i, /PR head/i, /\bfinish\b/i);
  expectAction(prompt, /resolve/i, /PR head/i, /PR number/i);
  expectAction(prompt, /require[^.!?]{0,40}reviewed\.clean/i, /\btrue\b/i, /PR work/i);
  expectAction(prompt, /treat[^.!?]{0,80}accept/i, /not accepted/i, /Checks/i);
  expectProhibition(prompt, /finish/i, /verified/i);
  expectAction(prompt, /abort/i, /notDone/i, /\bopen\b/i);
  expectAction(prompt, /record[^.!?]{0,60}unresolved compare/i, /notDone/i, /\bopen\b/i);
});

// Usefulness: verifies the headless prompt names the machine-readable marker the
// parent sets when it records an unresolved PR-head compare, and shows it inside
// the finish action object, so the runtime can turn it into a distinct
// unresolved-compare event (issue #266, issue #328).
test("initialPrompt names the unresolvedCompare marker", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectAction(prompt, /add[^.!?]{0,40}unresolvedCompare/i, /\btrue\b/i, /\bfinish\b/i);
  expectClause(prompt, /marker/i, /action object/i, /unresolved/i);
  expect(prompt).toContain(
    '{"action": "finish", "summary": {"changed": "<summary>", "verified": "<summary>", "deferred": "<summary>", "notDone": "<summary>", "open": "<summary>"}, "unresolvedCompare": true}',
  );
  expect(prompt).toContain("unresolved-compare event");
  expect(prompt).toContain("exits 4 instead of 0");
  // The marker is the only machine-readable record of the compare, so the prompt
  // must state that consequence and the instruction to set it, or the parent has
  // no reason to comply beyond the rule (#286).
  expectAction(prompt, /always set/i, /machine-readable/i, /omitted/i, /verified/i);
});

// The parent rules the interactive instructions and the headless prompt share.
// Each entry is one check run against both texts, so a rule that one text states
// and the other does not, or that either text states with the negation dropped or
// the action unbound, fails the parity check (issue #217, issue #252, #328).
const SHARED_PARENT_RULES = [
  (text) => expectRule(text, /PR work/i, /pull request/i),
  (text) =>
    expectAction(
      text,
      /name[^.!?]{0,40}PR branch/i,
      /worker/i,
      /commit/i,
      /push/i,
      /reviewed head/i,
    ),
  (text) => expectOrder(text, /PR number/i, /head commit/i),
  (text) => expectClause(text, /headless/i, /task/i, /PR number/i),
  (text) => expectAction(text, /compare/i, /reviewed\.head/i, /PR head/i, /\bfinish\b/i),
  (text) => expectAction(text, /resolve/i, /PR head/i, /PR number/i),
  (text) => expectAction(text, /require[^.!?]{0,40}reviewed\.clean/i, /\btrue\b/i, /PR work/i),
  (text) => expectAction(text, /treat[^.!?]{0,80}accept/i, /not accepted/i, /Checks/i),
  (text) => expectProhibition(text, /finish/i, /verified/i),
  (text) => expectAction(text, /abort/i, /notDone/i, /\bopen\b/i),
  (text) => expectAction(text, /record[^.!?]{0,60}unresolved compare/i, /notDone/i, /\bopen\b/i),
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
  // A finish before a reviewer accept on the changed state is prohibited, and the
  // accept is the one a later reviewer turn returns for that state.
  expectProhibition(prompt, /finish/i, /reviewer accept/i, /changed state/i);
  expectAction(prompt, /finish/i, /only|once|until/i, /reviewer/i, /Verdict: accept/i, /state/i);
  // With no worker turn, the task is review-only: finish on the reviewer report
  // whatever the verdict, and record that verdict in verified.
  expectClause(prompt, /worker/i, /review-only/i, /\bfinish\b/i);
  expectAction(prompt, /record[^.!?]{0,40}verified/i, /verdict/i);
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
  expectProhibition(roleLine, /run/i, /agent CLIs|background processes/i);
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
