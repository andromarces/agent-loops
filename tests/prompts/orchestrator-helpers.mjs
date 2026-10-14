// Fixtures shared by the orchestrator prompt test files.
import { expect } from "vite-plus/test";
import { initialPrompt } from "../../src/prompts/orchestrator.mjs";

/** The clauses of a prompt or instruction text, whitespace collapsed. */
export const clauses = (text) => text.replace(/\s+/g, " ").split(/[.;]\s+/);

// Asserts one clause of the text carries the rule. Every term must sit in that one
// clause, so a term moved to another clause, or swapped with another, fails.
export function expectRule(text, ...terms) {
  const stated = clauses(text).some((clause) => terms.every((term) => term.test(clause)));
  expect(stated, `no clause carries ${terms.map(String).join(" ")}`).toBe(true);
}

// The reviewer-Checks gate rule, checked for presence only: one sentence names
// the reviewer Checks line and a gate input. A reword that keeps those two nouns
// passes, and a removed rule fails. Reading an inversion out of prose is out of
// scope here, so the behavior the rule describes is covered where it runs, in
// `--require-accept refuses a finish that relies on a worker Checks line` in
// tests/role.finish-abort.test.mjs.
const REVIEWER_GATE_SENTENCE =
  /[^.!?]*(?:reviewer'?s? checks line[^.!?]*gate input|gate input[^.!?]*reviewer'?s? checks line)[^.!?]*[.!?]/i;

/** Asserts the text states the reviewer-Checks gate rule. */
export function expectReviewerGateRule(text) {
  expect(text).toMatch(REVIEWER_GATE_SENTENCE);
}

// The rule-bearing clauses of the reviewed-state parent rules. Each keeps the
// action with the term that gives it meaning, so a reversed rule fails: the
// compare names both heads, `reviewed.clean: true` keeps its value, an accept
// without a Checks line is not accepted, and the unresolved-compare rule keeps
// "do not finish as verified" with its abort and its record.
export const COMPARE_BEFORE_FINISH =
  /compare[^.!?]{0,40}reviewed\.head[^.!?]{0,40}PR head[^.!?]{0,40}\bfinish\b/i;

export const RESOLVE_PR_HEAD = /resolve[^.!?]{0,40}PR head[^.!?]{0,40}PR number/i;

export const REQUIRE_CLEAN_TRUE = /require[^.!?]{0,40}reviewed\.clean[^.!?]{0,20}\btrue\b/i;

export const ACCEPT_WITHOUT_CHECKS =
  /treat[^.!?]{0,60}accept[^.!?]{0,40}without[^.!?]{0,20}Checks[^.!?]{0,20}not accepted/i;

// The unresolved-compare rule, clause by clause. `do not finish as verified` is the
// prohibition, and the clause that follows must offer both permitted actions as
// alternatives of one choice. The two actions are joined directly by `or`, and the run
// from `record` to `unresolved compare` may cross neither punctuation nor a clause, so
// the words of one option cannot be read out of two separate clauses or two separate
// choices. The order is not the contract, so both orders pass, and a clause that drops
// either action fails (issue #351).
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

// A sentence that denies network, GitHub, or a check read to a turn must say that the limit
// covers shell commands, in the sentence or in the one after it, so a reader never takes the
// Codex sandbox for a block on a model-side tool or another channel. The positive-phrase tests
// above cannot catch a contradicting sentence, so this scan reads every sentence of every surface
// that states such a limit (issue #421, ADR 0019). A denial is a negation near network, GitHub, or
// the required checks: `cannot reach ... network`, `no turn can read the checks`, `blocks
// network`, `cannot run gh`, `with no network access`.
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
