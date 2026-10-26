import { describe, expect, test } from "vite-plus/test";
import { reviewerPrompt } from "../../src/prompts/reviewer.mjs";
import {
  initialPrompt,
  refusalPrompt,
  repairPrompt,
  requiredCheckWait,
  resultPrompt,
} from "../../src/prompts/orchestrator.mjs";
import {
  clauses,
  expectRule,
  expectReviewerGateRule,
  COMPARE_BEFORE_FINISH,
  RESOLVE_PR_HEAD,
  REQUIRE_CLEAN_TRUE,
  ACCEPT_WITHOUT_CHECKS,
  UNRESOLVED_HEAD_CONDITION,
  DO_NOT_FINISH_AS_VERIFIED,
  BOTH_ACTIONS_ON_UNRESOLVED,
  RECORD_UNDER_NOT_DONE_AND_OPEN,
  gatedPrompt,
  NETWORK_DENIAL,
  sentencesOf,
  unqualifiedDenials,
} from "./orchestrator-helpers.mjs";

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

// Usefulness: verifies requirement "the headless prompt states the unknown-key refusal and its
// repair" (issue #1021) with the right split: the action object allows action, summary, and a boolean
// unresolvedCompare, the nested summary object allows only the five summary keys. A clause that
// swaps or merges the two allowlists fails, which a bare keyword match would not catch.
test("initialPrompt states the unknown-key finish refusal and its repair", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  const clauseWith = (term) => clauses(prompt).find((clause) => term.test(clause));

  const action = clauseWith(/\bfinish action object\b/i);
  expect(action, "no clause names the action object allowlist").toBeDefined();
  expect(action).toMatch(
    /\bonly\b[^.]*\baction\b[^.]*\bsummary\b[^.]*\bboolean unresolvedCompare\b/i,
  );
  expect(action).not.toMatch(/\bfive\b/i);

  const summary = clauseWith(/\bsummary object\b/i);
  expect(summary, "no clause names the summary object allowlist").toBeDefined();
  expect(summary).toMatch(/\bonly the five summary keys\b/i);
  expect(summary).not.toMatch(/\bunresolvedCompare\b/);

  expectRule(prompt, /\brefused\b/i, /\bany other key\b/i, /\beither object\b/i);
  expectRule(prompt, /\brefusal\b/i, /\bnames each unknown key\b/i);
  expectRule(prompt, /\bresend\b/i, /\bfinish\b/i, /\bonly\b/i, /\ballowed keys\b/i);
});

// Usefulness: verifies requirement "the headless prompt states the allowed keys of run_worker,
// run_reviewer, and abort" (#1034). Each action names its own keys, so a clause that gives abort a
// `prompt` or a dispatch a `reason` fails.
test("initialPrompt states the allowed keys of the dispatch and abort actions", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  const clauseWith = (term) => clauses(prompt).find((clause) => term.test(clause));

  const dispatch = clauseWith(/\brun_worker and run_reviewer actions allow only\b/i);
  expect(dispatch, "no clause names the dispatch allowlist").toBeDefined();
  expect(dispatch).toMatch(/\bonly\b[^.]*\baction\b[^.]*\bprompt\b/i);
  expect(dispatch).not.toMatch(/\breason\b/i);

  const abort = clauseWith(/\babort action allows only\b/i);
  expect(abort, "no clause names the abort allowlist").toBeDefined();
  expect(abort).toMatch(/\bonly\b[^.]*\baction\b[^.]*\breason\b/i);
  expect(abort).not.toMatch(/\bprompt\b/i);

  expectRule(prompt, /\brefused\b/i, /\bany other key\b/i, /\bnames each unknown key\b/i);
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

// Usefulness: verifies the headless prompt tells the parent to carry a criterion that the
// reviewer could not check into deferred, without a further turn unless the task requires
// the check in this run, so the rule from the reviewer scope reaches the finish (issue #838).
test("initialPrompt carries an unverified criterion into deferred", () => {
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 });
  expectRule(prompt, /carry it into deferred/i, /not verified/i);
  expectRule(
    prompt,
    /do not dispatch another turn[^.!?]{0,60}\bcheck\b/i,
    /must pass in this run/i,
  );
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

// Usefulness: verifies the headless result payload carries the inherited temporary directory
// entries a reviewer turn left, so a headless parent holds what a `role dispatch` envelope carries
// (issue #1024).
test("resultPrompt carries the inherited temporary directory entries of a reviewer result", () => {
  const prompt = resultPrompt({
    result: {
      role: "reviewer",
      status: "ok",
      response: "done",
      inheritedTmpdirEntries: ["m54-3db54ca8"],
    },
    stepsUsed: 1,
    maxSteps: 3,
  });
  expect(prompt).toContain('"inheritedTmpdirEntries"');
  expect(prompt).toContain("m54-3db54ca8");
});

// Usefulness: verifies the headless result payload carries the package store entries a reviewer
// turn changed, so a headless parent holds what a `role dispatch` envelope carries (issue #1045).
test("resultPrompt carries the package store entries of a reviewer result", () => {
  const prompt = resultPrompt({
    result: {
      role: "reviewer",
      status: "ok",
      response: "done",
      packageStoreEntries: ["v11/projects/hash1"],
    },
    stepsUsed: 1,
    maxSteps: 3,
  });
  expect(prompt).toContain('"packageStoreEntries"');
  expect(prompt).toContain("v11/projects/hash1");
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

// Usefulness: verifies a run with no --mode keeps the prompt text it had before the flag existed
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
    "- This run declares PR #42. Finish it through --require-ci 42 for that same PR. The runtime refuses a finish that has no gate, a gate for another PR, or unresolvedCompare. A gate for another PR is not read. A matching gate still applies its own conditions. One refusal names every condition that failed. At start, the runtime read the required-check sources of PR #42 once and refused a run whose repository rulesets it could not read, for example a private Free-plan repository, because the gate would refuse every finish of such a run; the recovery is to omit --pr and pass --compare-head 42 to the headless command, which compares the PR head without reading a required-check source, or to finish with unresolvedCompare. A read that failed for another reason, such as a transport failure, warned and let the run start, so the gate can still refuse at finish.";
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
  // The existing gate line is still what follows, naming the declared PR.
  expect(withPrAndGate).toContain(
    `${block}\n- This run enforces the PR gate (--require-ci 42): the runtime resolves the PR head from the run's PR number and refuses a finish until the PR head is the reviewed commit`,
  );
});

// Usefulness: verifies the start-read sentence of #1092 appears only for a run whose start made the
// read. A continuation that restored its PR skips the read, so its prompt must not claim one; a
// continuation that declares a new PR makes the read and says so.
test("the start-read sentence is absent from a continued run that restored its PR", () => {
  const sentence = "At start, the runtime read the required-check sources of PR #42";
  const base = { task: "T", maxSteps: 10, pr: 42 };
  expect(initialPrompt(base)).toContain(sentence);
  expect(initialPrompt({ ...base, continued: true })).not.toContain(sentence);
  expect(initialPrompt({ ...base, continued: true, startRead: true })).toContain(sentence);
});

// Usefulness: verifies a run that declares no PR keeps the prompt it sent
// before the PR declaration existed, because the declaration block is the only addition and it is empty
// without `--pr` (#302).
test("initialPrompt adds nothing to a run that declares no PR", () => {
  const prompt = initialPrompt({ task: "T", maxSteps: 10, requireCi: 42 });
  expect(prompt).not.toContain("declares PR");
  expect(prompt).not.toContain("This run declares");
  // The gate block for the same inputs is still present and unchanged.
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

// Usefulness: verifies the wait rule states the turn cost, because a headless
// orchestrator turn that outlasts the per-invocation timeout ends the run instead
// of returning an action (issue #319).
test("initialPrompt states that a wait can end the run at the turn timeout", () => {
  const prompt = gatedPrompt("claude");
  expect(prompt).toMatch(/--timeout/);
  expect(prompt).toMatch(/exit 1/);
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
  expect(prompt).toContain("A status of slot-timeout means that the command did not run");
});

// Usefulness: verifies the initial prompt states the actual Codex reviewer mode, and no mode for a
// run that names none (a reviewer that is not Codex), so the prompt never describes a sandbox that
// the run does not have (ADR 0038).
test.each([
  ["none", /no sandbox/, /read-only sandbox|workspace-write/],
  ["read-only", /read-only sandbox/, /no sandbox|workspace-write/],
  ["workspace-write", /workspace-write sandbox/, /no sandbox|read-only sandbox/],
])("the initial prompt states the %s reviewer mode", (reviewerSandbox, has, lacks) => {
  const prompt = initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox });
  expect(prompt).toMatch(has);
  expect(prompt).not.toMatch(lacks);
  expect(prompt).toContain("Your own turns stay read-only");
  expect(prompt).toContain("halts the run");
  // Usefulness: verifies the file-change scope reads the same in every mode (issue #837), so an
  // orchestrator never tells a reviewer to skip a test run that writes only ignored output.
  expect(prompt).toContain(
    "The reviewer still must not change a tracked file or an untracked file that Git does not ignore, including a cache file, and must not change Git state or write to a remote.",
  );
  expect(prompt).toContain(
    "A test run is allowed when every write goes to an ignored path or to a temporary file outside the repository.",
  );
  expect(prompt).not.toContain("must not change files");
});

test("the initial prompt names no reviewer mode when the run has none", () => {
  const base = { task: "t", maxSteps: 5 };
  expect(initialPrompt(base)).toBe(initialPrompt({ ...base, reviewerSandbox: null }));
  expect(initialPrompt(base)).not.toMatch(/no sandbox|read-only sandbox|workspace-write/);
});

// Usefulness: verifies the required-check rule for a Codex reviewer per mode (ADR 0038): no sandbox
// keeps shell network, so a non-waiting orchestrator gets the reviewer rule, a waiting one still
// waits, and either sandboxed mode, or no mode named, stays on the gate rule.
test.each([
  ["codex", "none", "reviewer"],
  ["copilot", "none", "reviewer"],
  [null, "none", "reviewer"],
  ["claude", "none", "wait"],
  ["agy", "read-only", "wait"],
  ["opencode", "workspace-write", "wait"],
  ["codex", "read-only", "gate"],
  ["codex", "workspace-write", "gate"],
  ["codex", null, "gate"],
])(
  "requiredCheckWait for a %s orchestrator and a codex reviewer in mode %s is %s",
  (orchestratorKind, reviewerSandbox, expected) => {
    expect(
      requiredCheckWait({
        requireCi: 42,
        orchestratorKind,
        reviewerKind: "codex",
        reviewerSandbox,
      }),
    ).toBe(expected);
  },
);

// Usefulness: verifies the reviewer rule line for a no-sandbox Codex reviewer says it has no
// sandbox, and does not repeat the read-only claim of the reviewers that keep one (ADR 0038).
test("the reviewer-rule line fits a Codex reviewer with no sandbox", () => {
  const prompt = initialPrompt({
    task: "t",
    maxSteps: 5,
    requireCi: 42,
    orchestratorKind: "codex",
    reviewerKind: "codex",
    reviewerSandbox: "none",
  });
  expect(prompt).toContain(
    "The reviewer of this run is codex, whose turn runs with no sandbox and keeps shell network",
  );
  expect(prompt).not.toContain("whose read-only turn keeps shell network");
});

const gated = (extra) => initialPrompt({ task: "t", maxSteps: 5, requireCi: 42, ...extra });

// Usefulness: verifies no denial of network or of a check read stays unqualified in the rendered
// orchestrator prompt, for the default run and the opted-in run, for every gate rule, with and
// without a declared PR, so the prompt never overstates what the Codex sandbox isolates.
describe.each([
  ["no-mode", null],
  ["none", "none"],
  ["read-only", "read-only"],
  ["workspace-write", "workspace-write"],
])("the %s orchestrator prompt qualifies every network denial", (_name, reviewerSandbox) => {
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
    const prompt = gated({ orchestratorKind, reviewerKind, pr, reviewerSandbox });
    expect(unqualifiedDenials(prompt)).toEqual([]);
  });

  test("the ungated prompt", () => {
    expect(unqualifiedDenials(initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox }))).toEqual(
      [],
    );
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
  ["no-mode", null],
  ["none", "none"],
  ["read-only", "read-only"],
  ["workspace-write", "workspace-write"],
])("the %s runtime prompts state the user-rule exception", (_name, reviewerSandbox) => {
  test.each([
    ["codex", "codex", null],
    ["codex", "codex", 42],
    ["codex", "claude", 42],
    ["copilot", "codex", 42],
    ["claude", "codex", null],
    [null, null, null],
  ])("%s orchestrator, %s reviewer, pr %s", (orchestratorKind, reviewerKind, pr) => {
    const prompt = gated({ orchestratorKind, reviewerKind, pr, reviewerSandbox });
    expect(denialsWithoutUserRuleException(prompt)).toEqual([]);
  });

  test("the ungated prompt", () => {
    expect(
      denialsWithoutUserRuleException(initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox })),
    ).toEqual([]);
  });
});

// Usefulness: verifies that the opted-in reviewer prompt carries the exact user-rule exception
// text (issue #655).
test("the opted-in reviewer prompt states the user-rule exception", () => {
  expect(
    denialsWithoutUserRuleException(reviewerPrompt("x", null, null, "workspace-write")),
  ).toEqual([]);
  expect(reviewerPrompt("x", null, null, "workspace-write").replace(/\s+/g, " ")).toContain(
    USER_RULE_EXCEPTION,
  );
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

// Usefulness: verifies requirement "a denied shell call shows in the result of the turn" (issue #713) for a headless parent: `resultPrompt` was the only place a child result is rendered, so a dropped field is lost to the orchestrator.
test("the result prompt carries shellDenied only when the result has it", () => {
  const base = { role: "worker", status: "ok", response: "done" };
  const denied = resultPrompt({
    result: { ...base, shellDenied: true },
    stepsUsed: 1,
    maxSteps: 5,
  });
  const clean = resultPrompt({ result: base, stepsUsed: 1, maxSteps: 5 });
  expect(denied).toContain('"shellDenied": true');
  expect(clean).not.toContain("shellDenied");
});

// Usefulness: verifies the headless result prompt carries no raw line-separator character from a
// child response, an error, a test run, or a PR check read, and that the payload stays valid JSON
// that decodes to the original text (issue #761).
test("resultPrompt renders no raw line separator from untrusted result fields", () => {
  const hostile = "a\u{2028}b\u{2029}c\u0085d";
  const prompt = resultPrompt({
    result: {
      role: "reviewer",
      status: "ok",
      response: `Verdict${hostile}`,
      testRun: { command: `cmd${hostile}`, tail: `out${hostile}`, changedPaths: [hostile] },
      prChecks: { pr: 1, summary: `s${hostile}` },
    },
    stepsUsed: 1,
    maxSteps: 3,
  });
  for (const raw of ["\u{2028}", "\u{2029}", "\u0085"]) {
    expect(prompt).not.toContain(raw);
  }
  const json = prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}\n\n") + 1);
  expect(JSON.parse(json).response).toBe(`Verdict${hostile}`);
});

// Usefulness: verifies the refusal and repair prompts, which carry text from a child or a parent
// reply, render no raw line separator (issue #761).
test("refusalPrompt and repairPrompt render no raw line separator", () => {
  for (const prompt of [refusalPrompt("no\u{2028}accept\u0085"), repairPrompt("bad\u{2029}json")]) {
    for (const raw of ["\u{2028}", "\u{2029}", "\u0085"]) {
      expect(prompt).not.toContain(raw);
    }
  }
});

// Usefulness: verifies requirement "the envelope names a transient failure" (issue #1012) for a headless parent: `resultPrompt` renders the child result, so a dropped field is lost to the orchestrator.
test("the result prompt carries transient only when the error result has it", () => {
  const base = { role: "reviewer", status: "error", error: "codex exited with code 1." };
  const flagged = resultPrompt({
    result: { ...base, transient: "capacity" },
    stepsUsed: 1,
    maxSteps: 5,
  });
  const plain = resultPrompt({ result: base, stepsUsed: 1, maxSteps: 5 });
  expect(flagged).toContain('"transient": "capacity"');
  expect(plain).not.toContain("transient");
});

// Usefulness: verifies the compare-head prompt states the continuation rule, so the orchestrator
// of a continued run knows the transcript records the flag but a continuation must pass it again
// and that omitting it disables the runtime compare (issue #1104). A run without the flag states none.
describe("compare-head run prompt", () => {
  const base = { task: "t", maxSteps: 3 };

  test("states that a continuation selects the flag again", () => {
    for (const continued of [false, true]) {
      const prompt = initialPrompt({ ...base, compareHead: 42, continued });
      expect(prompt).toContain("--compare-head 42");
      expect(prompt).toContain(
        "The transcript records the flag, but a continuation does not restore it",
      );
      expect(prompt).toContain("omitting it on a continuation runs no runtime compare");
    }
    expect(initialPrompt(base)).not.toContain("--compare-head");
  });
});
