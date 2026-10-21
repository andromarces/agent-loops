// Fixtures shared by the orchestrator prompt test files.
import { expect } from "vite-plus/test";
import { initialPrompt } from "../../src/prompts/orchestrator.mjs";

// A prompt rule is asserted as the short clause that carries it, never as a whole prompt sentence.
// A same-meaning reword of the surrounding prose then passes, and a changed rule fails. Where the
// polarity of a rule is the contract, the clause keeps the negation and the action together.
// Then "finish" cannot stand in for "do not finish". Where a runtime gate enforces a rule, the gate
// test covers the behavior. The prompt tests only assert that the prompt states the rule.

/** The clauses of a prompt or instruction text, whitespace collapsed. */
export const clauses = (text) => text.replace(/\s+/g, " ").split(/[.;]\s+/);

// Asserts one clause of the text carries the rule. Every term must sit in that one
// clause, so a term moved to another clause, or swapped with another, fails.
export function expectRule(text, ...terms) {
  const stated = clauses(text).some((clause) => terms.every((term) => term.test(clause)));
  expect(stated, `no clause carries ${terms.map(String).join(" ")}`).toBe(true);
}

// The reviewer-Checks gate rule is checked for presence only: one sentence names the reviewer
// Checks line and a gate input. A reword that keeps those two nouns passes, and a removed rule
// fails. Reading an inversion out of prose is out of scope here. The behavior of the rule is
// covered where it runs, in `--require-accept refuses a finish that relies on a worker Checks line`
// in tests/role.finish-abort.test.mjs.
const REVIEWER_GATE_SENTENCE =
  /[^.!?]*(?:reviewer'?s? checks line[^.!?]*gate input|gate input[^.!?]*reviewer'?s? checks line)[^.!?]*[.!?]/i;

/** Asserts the text states the reviewer-Checks gate rule. */
export function expectReviewerGateRule(text) {
  expect(text).toMatch(REVIEWER_GATE_SENTENCE);
}

// The rule-bearing clauses of the reviewed-state parent rules. Each keeps the action with the term
// that gives it meaning, so a reversed rule fails. The compare names both heads, `reviewed.clean:
// true` keeps its value, and an accept without a Checks line is not accepted. The
// unresolved-compare rule keeps "do not finish as verified" with its abort and its record.
export const COMPARE_BEFORE_FINISH =
  /compare[^.!?]{0,40}reviewed\.head[^.!?]{0,40}PR head[^.!?]{0,40}\bfinish\b/i;

export const RESOLVE_PR_HEAD = /resolve[^.!?]{0,40}PR head[^.!?]{0,40}PR number/i;

export const REQUIRE_CLEAN_TRUE = /require[^.!?]{0,40}reviewed\.clean[^.!?]{0,20}\btrue\b/i;

export const ACCEPT_WITHOUT_CHECKS =
  /treat[^.!?]{0,60}accept[^.!?]{0,40}without[^.!?]{0,20}Checks[^.!?]{0,20}not accepted/i;

// The unresolved-compare rule is checked clause by clause: `do not finish as verified` is the
// prohibition. The clause that follows must offer both permitted actions as alternatives of one
// choice. The two actions are joined directly by `or`. The run from `record` to `unresolved
// compare` must cross neither punctuation nor a clause. So the words of one option cannot be read
// out of two separate clauses or two separate choices. The order is not the contract, so both
// orders pass, and a clause that drops either action fails (issue #351).
export const UNRESOLVED_HEAD_CONDITION = /PR head cannot be resolved/i;

export const DO_NOT_FINISH_AS_VERIFIED = /do not finish as verified/i;

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

export const BOTH_ACTIONS_ON_UNRESOLVED = new RegExp(
  `${ABORT_THEN_RECORD_THE_COMPARE.source}|${RECORD_THE_COMPARE_THEN_ABORT.source}`,
  "i",
);

export const RECORD_UNDER_NOT_DONE_AND_OPEN =
  /record[^.!?]{0,40}unresolved compare[^.!?]{0,40}notDone[^.!?]{0,20}\bopen\b/i;

export const gatedPrompt = (orchestratorKind, reviewerKind = "claude") =>
  initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind,
    reviewerKind,
  });

// A sentence that denies network, GitHub, or a check read to a turn must say that the limit covers
// shell commands. It says so in the same sentence or the next. A reader then never takes the Codex
// sandbox for a block on a model-side tool or another channel. The positive-phrase tests above
// cannot catch a contradicting sentence, so this scan reads every sentence of each such surface
// (issue #421, ADR 0019). A denial is a negation near network, GitHub, or the required checks.
// Examples: `cannot reach ... network`, `no turn can read the checks`, `blocks network`, `cannot
// run gh`, `with no network access`.
export const NETWORK_DENIAL = new RegExp(
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

export const sentencesOf = (text) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.:;])\s+(?=[A-Z`-])|\s\|\s/)
    .map((sentence) => sentence.trim());

export function unqualifiedDenials(text) {
  const sentences = sentencesOf(text);
  return sentences.filter(
    (sentence, i) =>
      NETWORK_DENIAL.test(sentence) && !/shell/i.test(`${sentence} ${sentences[i + 1] ?? ""}`),
  );
}

// The target of every commit or push instruction in the text: the phrase after the
// preposition, up to the next clause mark. A commit and a push in one clause each
// yield a target, so a second target naming another branch is caught.
const BRANCH_TARGET =
  /\b(?:commit|push)(?:s|es)?\b[^.;]{0,40}?\b(?:on|onto|to)\s+([^,.;]{1,40}?)(?=\s+(?:and|so|but)\b|[,.;]|$)/gi;

// A target that names a branch instead of pointing at the one the dispatcher
// supplied. A back-reference is a determiner and the word "branch" and nothing
// else, so `main` and `the main branch` each name a branch of their own.
export const NAMED_TARGET = /^(?!\s*(?:the|that|this|your|its)\s+branch(?:es)?\s*$)\S/i;

/** Every commit or push target in the text, whitespace collapsed. */
export function commitTargets(text) {
  const flat = text.replace(/\s+/g, " ");
  return [...flat.matchAll(new RegExp(BRANCH_TARGET.source, "gi"))].map((match) => match[1].trim());
}

// The refused-`--cwd` rule is that the parent does not repair or recreate the work tree and leaves
// it to a maintainer. It is asserted twice. One sentence must state it with the negation, the
// parent, and the maintainer together, so a removed or negated rule fails. And no sentence anywhere
// in the text may tell the parent to repair, recreate, or rebuild a work tree, so an added
// instruction fails wherever it sits and whichever of these verbs it uses. A recovery act is safe
// only when a maintainer or a negation governs it in the same clause. known-limit: a recovery verb
// outside RECOVERY_ACT is not caught, and a maintainer or negation earlier in the clause governs any
// act after it. Add the verb when a new one appears.
const STATES_REFUSED_CWD_RULE =
  /(?=[^.]*\bparent\b)(?=[^.]*\bmaintainer\b)(?=[^.]*\bwork tree\b)[^.]*\b(?:not|never)\b[^.]{0,40}\b(?:repair|re-?creat)\w*/i;
const RECOVERY_ACT = String.raw`(?:re-?(?:creat|build|construct|generat|stor|instat|init|clon|add|mak|install)|repair|restor|heal|mend|reset)\w*|recover(?:s|ed|ing)?\b|fix(?:es|ing)?\b`;
const CREATE_ACT = String.raw`(?:creat|mak|add|clon|initializ|provision|set up|mkdir)\w*`;
const WORK_TREE_OBJECT = /work ?tree|checkout|Git metadata|\.git\b|directory|folder|--cwd|path/i;
const REFUSED_STATE = /refus|no longer exist|\bgone\b|\blost\b|missing/i;
// What may stand before an act in its own clause: a maintainer or a negation, with no clause mark.
const GOVERNED_ACT = /(?:\bmaintainer(?:,\s+who)?|\b(?:not|never|cannot)\b|n't)[^,;:.]*$/i;

/** The recovery acts of one sentence that no maintainer or negation governs. */
function ungovernedRecoveryActs(sentence) {
  if (!WORK_TREE_OBJECT.test(sentence)) return [];
  const acts = REFUSED_STATE.test(sentence) ? `${RECOVERY_ACT}|${CREATE_ACT}` : RECOVERY_ACT;
  return [...sentence.matchAll(new RegExp(String.raw`\b(?:${acts})`, "gi"))]
    .filter((match) => !GOVERNED_ACT.test(sentence.slice(0, match.index).split(/[;:.]/).at(-1)))
    .map((match) => `${match[0]} in: ${sentence}`);
}

/** Asserts the text keeps the refused-`--cwd` rule and holds no instruction that reverses it. */
export function expectRefusedCwdRule(text) {
  const sentences = text.split(/ (?=#{1,6} )/).flatMap(sentencesOf);
  expect(
    sentences.some((sentence) => STATES_REFUSED_CWD_RULE.test(sentence)),
    "no sentence says the parent does not repair or recreate the work tree and leaves it to a maintainer",
  ).toBe(true);
  expect(
    sentences.flatMap(ungovernedRecoveryActs),
    "an instruction to recover a work tree",
  ).toEqual([]);
}
