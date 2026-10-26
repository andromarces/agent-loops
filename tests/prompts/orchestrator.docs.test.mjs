import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { reviewerPrompt } from "../../src/prompts/reviewer.mjs";
import { initialPrompt } from "../../src/prompts/orchestrator.mjs";
import {
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
  NAMED_TARGET,
  commitTargets,
  gatedPrompt,
  unqualifiedDenials,
} from "./orchestrator-helpers.mjs";

const instructionsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/orchestrator-instructions.md",
);

/** The only work tree command of the instructions: the creation step that sets no upstream (#985). */
const WORK_TREE_CREATE_COMMAND =
  "git worktree add --no-track -b <branch> <work tree> origin/<default>";
/** The creation step for a repository with no remote, where the base is the local default branch (#1099). */
const WORK_TREE_CREATE_NO_REMOTE_COMMAND =
  "git worktree add --no-track -b <branch> <work tree> <default>";
const WORK_TREE_REMOVE_COMMAND = 'git worktree remove --force "<work tree>"';

const referenceSectionsDir = join(dirname(instructionsPath), "orchestrator");

/** The reference section files of the instructions, sorted by name. */
async function referenceSectionNames() {
  return (await readdir(referenceSectionsDir)).filter((name) => name.endsWith(".md")).sort();
}

/** The instructions as one text: the core, then every reference section file. */
async function readInstructions() {
  const names = await referenceSectionNames();
  const parts = [
    readFile(instructionsPath, "utf8"),
    ...names.map((name) => readFile(join(referenceSectionsDir, name), "utf8")),
  ];
  return (await Promise.all(parts)).join("\n\n");
}

/** The user docs as one text: the reference topic files, the reference index, then the README. */
async function readUserDocs() {
  const docs = join(dirname(instructionsPath), "reference");
  const topics = (await readdir(docs)).filter((name) => name.endsWith(".md")).sort();
  const paths = [
    ...topics.map((name) => join(docs, name)),
    join(dirname(instructionsPath), "reference.md"),
    join(dirname(instructionsPath), "../README.md"),
  ];
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n\n");
}

// Asserts no commit or push in the text targets a branch of the rule's own, so a
// target such as `main` or `origin/main` fails.
function expectNoNamedBranchTarget(text) {
  for (const target of commitTargets(text)) {
    expect(NAMED_TARGET.test(target), `the rule commits on ${target}, a branch of its own`).toBe(
      false,
    );
  }
}

// The parent rules that the interactive instructions and the headless prompt share. Each entry is
// one check run against both texts. A rule that one text states and the other does not fails the
// parity check. So does a rule that either text states with the negation dropped or the action
// unbound (issue #217, issue #252, #328).
const SHARED_PARENT_RULES = [
  (text) => expectRule(text, /PR work/i, /pull request/i),
  (text) =>
    expectRule(text, /name[^.!?]{0,40}PR branch/i, /worker/i, /commit/i, /push/i, /reviewed head/i),
  // Every commit or push that the parent rule names must target the branch that it just named,
  // never a branch of its own. So `on main` and `origin/main` fail.
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
  // Issue #910: a PR-work worker envelope with `clean: false` gets a worker correction, never a
  // reviewer.
  (text) =>
    expectRule(
      text,
      /workTree/,
      /clean: false/,
      /PR work/i,
      /dispatch (?:a|the) worker/i,
      /not (?:a|the) reviewer/i,
    ),
  // Issue #984: a change to shared Git state from a linked work tree is reported by item name, and
  // the parent reports it.
  (text) =>
    expectRule(text, /sharedGitChanged/, /core\.hooksPath/, /hooks\//, /remote/i, /outside/i),
  (text) => expectRule(text, /never a value/i, /URL/),
  (text) => expectRule(text, /main work tree/i, /linked work tree/i),
  (text) => expectRule(text, /Report it/i, /finish summary/i),
  (text) => expectRule(text, /failed worker turn/i, /field too/i),
  // Issue #1024: a reviewer envelope names the entries that appeared in the inherited temporary
  // directory, as advisory evidence that the runtime cannot attribute, and the parent reports it.
  (text) =>
    expectRule(text, /inheritedTmpdirEntries/, /reviewer/i, /inherited temporary directory/i),
  (text) => expectRule(text, /cannot attribute/i, /not delete/i),
  (text) => expectRule(text, /Report it/i, /open/i),
  // Issue #1045: a reviewer envelope names the pnpm package store entries that changed, as advisory
  // evidence, and the parent reports it under open instead of rejecting.
  (text) => expectRule(text, /packageStoreEntries/, /reviewer/i, /package store/i),
  (text) => expectRule(text, /advisory/i, /cannot attribute/i, /not revert/i),
  (text) => expectRule(text, /packageStoreEntries/, /Report/, /open/, /not .*reject/i),
  // Issue #1002: after a push to a branch with an open PR, the worker updates the PR body in place
  // and adds no revision log.
  (text) => expectRule(text, /no revision log/i, /body/i, /comment/i),
  (text) =>
    expectRule(
      text,
      /after each push/i,
      /open PR/i,
      /updates the PR body in place/i,
      /describes the pushed head/i,
    ),
  // Issue #1115: the PR body holds only committed or published state and no local-only detail.
  (text) =>
    expectRule(
      text,
      /committed or published repository state/i,
      /untracked file/i,
      /local-only change/i,
      /local probe/i,
      /machine-specific path/i,
    ),
];

// Usefulness: verifies the interactive instructions and the headless prompt state the same
// reviewed-state parent rules (issue #217, issue #252, issue #328). The two parent paths never
// diverge. The reviewer-Checks gate rule uses the same presence check as the gate test. A reword
// keeps the parity check, and a removal breaks it (issue #318).
test("interactive instructions and headless prompt share the reviewed-state rules", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  for (const rule of SHARED_PARENT_RULES) {
    rule(instructions);
    rule(prompt);
  }
  expectReviewerGateRule(instructions);
  expectReviewerGateRule(prompt);
});

// Usefulness: verifies the headless prompt states the gate outcome on a base branch whose
// required-check sources each state it holds none (issue #336). The gate passes on the PR head, the
// clean reviewed tree, and the merge state, and records the absence. An orchestrator on such a
// branch then knows the gate can pass and what it did not verify.
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
  const instructions = await readInstructions();
  expectRule(instructions, /no required check/i, /pass/i, /PR head/i, /reviewed/i, /merge state/i);
  expectRule(instructions, /no required check/i, /record/i);
  expectRule(instructions, /cannot read/i, /refus/i);
});

// Usefulness: verifies both parent surfaces state the action for the `noRequiredChecks` wait
// outcome: dispatch the reviewer, wait no more, and never record a pass (issue #894). A parent
// that misses it reads the outcome as a read error or as a passed check.
test("the parent surfaces state the action for a wait with no required check", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  for (const text of [prompt, instructions]) {
    expectRule(text, /noRequiredChecks/, /dispatch the reviewer/i, /never record/i);
  }
});

// Usefulness: verifies both parent surfaces state when the parent runs the `--all` wait: after a
// `noRequiredChecks` outcome, so the reviewer starts after CI completes (issue #896). A parent that
// misses it dispatches the reviewer before CI settles, which costs a turn.
test("the parent surfaces state when to wait on every check of the head", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  for (const text of [prompt, instructions]) {
    expectRule(text, /noRequiredChecks/, /wait-checks[^.]*--all/i, /never record/i);
  }
});

// Usefulness: verifies both parent surfaces name `--expect` in the `noRequiredChecks` flow, so a
// parent passes the name of a check that a third-party app registers late instead of reading an
// early pass as evidence (issue #978).
test("the parent surfaces name --expect for a check that registers late", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  for (const text of [prompt, instructions]) {
    expectRule(text, /--expect/, /--all/, /late/i);
    expectRule(text, /awaiting/, /never a pass/i);
    // Exact name matching, and a commit status never satisfies a name (issue #978).
    expectRule(text, /check run/i, /exact/i, /trimmed/i, /case-sensitiv/i, /any app/i);
    expectRule(text, /commit status/i, /never match/i);
  }
});

// Usefulness: verifies both parent surfaces tell the parent to act only on the `noCheckSource` field of
// the `--all` envelope: dispatch the reviewer, record the CI status as not verified, never as passed
// (issue #1054). A parent that reads the workflows itself leaves its role contract, and one that
// records a pass from the field reports CI that no check backed.
test("the parent surfaces state the action for a noCheckSource wait", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  for (const text of [prompt, instructions]) {
    expectRule(text, /noCheckSource/, /(?:no|never a) pass/i);
    expectRule(text, /dispatch the reviewer/i, /not verified/i);
    expectRule(text, /never record the CI status as passed/i);
  }
});

// Usefulness: verifies every surface that states the `noCheckSource` rule names the merged PR head
// read and its sampling limit (issue #1062). A surface that omits them tells a parent that the
// skip proves more than two commits show.
test("the noCheckSource rule names the merged PR head read and its limit on every surface", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  const roleDoc = await readFile(join(dirname(instructionsPath), "reference/role.md"), "utf8");
  for (const text of [prompt, instructions, roleDoc]) {
    expectRule(text, /merged PR/i, /latest/i);
    expectRule(text, /base head and one merged PR head are two commits/i, /stays unseen/i);
  }
});

// Usefulness: verifies the interactive instructions state the three conditions of the
// `noCheckSource` return and its limit, and tell the parent to read none of them itself
// (issue #1054). A reworded rule that drops the workflow-file, trigger, or external-provider
// condition would let a skip start the reviewer before CI reports.
test("the instructions state the conditions of a noCheckSource wait", async () => {
  const instructions = await readInstructions();
  expectRule(instructions, /no `--expect` name is set/);
  expectRule(instructions, /changes no file under `\.github\/workflows\/`/);
  expectRule(
    instructions,
    /`pull_request`/,
    /`pull_request_target`/,
    /`push`/,
    /`merge_group`/,
    /`workflow_run`/,
    /`check_suite`/,
  );
  expectRule(instructions, /reusable workflow/i, /caller/i);
  expectRule(instructions, /no check run and no commit status from any source/i);
  expectRule(instructions, /GitHub App or third-party CI/i, /no workflow file/i);
  expectRule(instructions, /never read a workflow file/i, /yourself/i);
  expectRule(instructions, /keeps the normal wait/i, /fails|cannot be parsed|not settled/i);
  expectRule(instructions, /repository with a `pull_request` workflow keeps the wait/i);
  expectRule(instructions, /limit/i, /base head and one merged PR head are two commits/i);
  expectRule(instructions, /latest merged PR/i);
  expectRule(instructions, /never comes from the required wait/i);
});

/** The words of a text in order, so case, whitespace, Markdown marks, and punctuation never decide a match. */
const wordsOf = (text) =>
  text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    .join(" ");

/** The paragraph of `text` that holds `marker`, bounded by blank lines. */
function paragraphAround(text, marker) {
  const paragraph = text.split(/\r?\n[ \t]*\r?\n/).find((part) => part.includes(marker));
  expect(paragraph, `no paragraph holds: ${marker}`).toBeDefined();
  return paragraph;
}

/** The text of `text` between the end of `after` and the start of `before`. */
function textBetween(text, after, before) {
  const start = text.indexOf(after);
  expect(start, `no text holds: ${after}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(before, start);
  expect(end, `no text holds: ${before}`).toBeGreaterThan(start);
  return text.slice(start + after.length, end);
}

// The refusal rule as each parent surface states it, from its fixed start to the end of its
// exclusion sentence. A reworded rule must update these passages.
const DOCS_REFUSAL_PASSAGE =
  'When no source can state the required checks, the required wait cannot say whether the PR holds a required check, so it refuses with exit 1 and `status: "error"`. The error says that a source `settled nothing`, that a source `could not be read`, or that a source `did not state that it holds no required check`, and that the required checks of the PR are unresolved. The 403 of a private repository on the GitHub Free plan (#301) is that case. It is no required-check read, so do not run the required wait again. Run the `--all` wait below once, as after `noRequiredChecks`, then dispatch the reviewer, which reads the CI status of the PR head itself. An `--all` pass is never a required-check pass: never record the CI status as passed from it, from this refusal, or from a `noRequiredChecks` envelope. The `--require-ci` gate still decides the finish, and it refuses a declared run there. Any other `status: "error"` stays an unresolved read, including a reply that could not be parsed and a failed read of the required check names: do not run `--all` for it.';
const PROMPT_REFUSAL_PASSAGE =
  'An exit 1 with "status": "error" whose error says that a required-check source settled nothing, could not be read, or did not state that it holds no required check, so the required checks are unresolved, as the 403 of a private repository on the GitHub Free plan does, is a refusal and not a read failure: run the same --all command once, as for noRequiredChecks, then dispatch the reviewer, and never record the CI status as passed from the --all result or the refusal. Any other error, such as a reply that could not be parsed or a failed read of the required check names, stays an unresolved read with no --all run.';

// Usefulness: verifies both parent surfaces name the `--all` wait for the required wait's refusal
// when no required-check source can state the required checks (issue #1018). A parent on a private
// Free-plan repository (#301) otherwise has no wait it may run, because `--all` was allowed only
// after `noRequiredChecks`, and the required wait can no longer return that there. The whole passage
// is compared word for word, scope (a source that `settled nothing`, `could not be read`, or `did
// not state that it holds no required check`), action, and exclusions together, so no word added,
// removed, or changed inside it passes.
test("the parent surfaces name the --all wait for a refusal of every required-check source", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  const docsPassage = paragraphAround(instructions, "When no source can state the required checks");
  const promptPassage = textBetween(
    prompt,
    "as passed from the noRequiredChecks envelope.",
    "A check that a third-party app registers late",
  );
  expect(wordsOf(docsPassage)).toBe(wordsOf(DOCS_REFUSAL_PASSAGE));
  expect(wordsOf(promptPassage)).toBe(wordsOf(PROMPT_REFUSAL_PASSAGE));
});

// Usefulness: verifies both parent surfaces state that the required wait refuses at once on the
// no-checks-yet reply when no required-check source is readable, and that a readable source keeps
// the wait running (issue #1091). A parent that misses it expects a timeout where the refusal comes.
test("the parent surfaces state the refusal of a no-checks-yet reply with no readable source", async () => {
  const prompt = initialPrompt({
    task: "Implement feature X",
    maxSteps: 10,
    pr: 42,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    waitCommand: [{ shell: "bash or cmd", command: "agent-loop role wait-checks --cwd work" }],
  });
  const instructions = await readInstructions();
  for (const text of [prompt, instructions]) {
    expectRule(text, /refuses? at once/i, /first poll/i, /unresolved-source/i);
    expectRule(text, /readable source/i, /keeps? the (?:required )?wait/i);
  }
});

// The surfaces that state the empty-union rule of the gate. The reviewer found them contradicting
// each other, so one rule is asserted on each. Only an allowlisted reply proves an absence, and a
// private Free-plan repository must omit `--pr`. Usefulness: verifies every surface states the same
// rule (#336 review). An orchestrator reading one is then not told that a run passes on a branch
// that the gate refuses.
const RULE_SURFACES = [
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["the user docs", readUserDocs],
];

for (const [name, load] of RULE_SURFACES) {
  // Usefulness: verifies ${name} states the allowlist rule, the one absence per source, and the
  // pagination and rule-type unknown (#336 review). It then cannot describe a partial, malformed,
  // or unreadable read as a pass.
  test(`${name} states the allowlisted absence rule`, async () => {
    const text = await load();
    expectRule(text, /allowlist/i, /fails closed/i);
    expectRule(text, /classes/i, /absent/i, /has-contexts/i, /empty/i, /unknown/i);
    // The one per-source absence each, and the ruleset read is every page.
    expectRule(text, /repository rulesets/i, /read of every page/i, /documented rule type/i);
    expectRule(text, /classic branch protection/i, /Branch not protected/);
    expectRule(text, /No successful classic-protection body proves an absence/i);
    // A read of no page at all is unknown, and exactly one empty page is empty. Those are two
    // different replies, and neither is a positive absence (#336 review).
    expectRule(text, /no page at all/i, /unknown/i);
    expectRule(text, /exactly one empty page/i, /empty/i, /positive absence/i);
    // An unlisted rule type settles nothing either.
    expectRule(text, /not a documented rule type/i, /unknown/i);
    // A rule on a later page is enforced rather than missed.
    expectRule(text, /paginated/i, /later page/i, /enforced/i);
  });

  // Usefulness: verifies ${name} states the four ruleset outcomes (#336 review). The empty ruleset
  // read is then not described with the name of a reply that refuses.
  test(`${name} states the four ruleset outcomes`, async () => {
    const text = await load();
    // A read the gate cannot interpret refuses whatever the union holds.
    expectRule(text, /ruleset read the gate cannot interpret/i, /refuses the finish/i, /union/i);
    // Exactly one empty page is neither, so a classic-only repository still
    // finishes, and the anomalous page sequences are named as refusals.
    expectRule(
      text,
      /exactly one empty page/i,
      /contributes no contexts/i,
      /per-check pass runs on the other sources/i,
    );
    expectRule(text, /no page at all/i, /two or more empty pages/i);
  });

  // Usefulness: verifies ${name} states that an empty page inside a longer read settles nothing
  // (#336 review). A partial read is then not classified from the pages that did arrive.
  test(`${name} states that an empty page inside a longer read settles nothing`, async () => {
    const text = await load();
    expectRule(text, /empty page inside a longer read/i, /nothing/i);
  });

  // Usefulness: verifies ${name} states that a ruleset-only branch reaches the
  // absence path, the case an earlier claim got backwards (#336 review).
  test(`${name} states that a ruleset-only branch reaches the absence path`, async () => {
    const text = await load();
    expectRule(text, /ruleset-only branch/i, /reaches|does/i);
  });

  // Usefulness: verifies ${name} states that a private Free-plan repository still refuses a
  // declared run and must omit `--pr` (#336 review). The gap that #336 leaves is then visible to
  // whoever reads it.
  test(`${name} states that a private Free-plan repository must omit --pr`, async () => {
    const text = await load();
    expectRule(text, /private/i, /Free.plan/i, /omit/i, /--pr/);
  });
}

// Usefulness: verifies the two parent paths state the same narrow exception (issue #319). An
// interactive parent and a headless orchestrator then resolve the role conflict the same way.
test("interactive instructions and headless prompt share the status-read exception", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  const prompt = gatedPrompt("claude").replace(/\s+/g, " ");
  for (const rule of ["status read", "not a review", "not a test"]) {
    expect(instructions).toContain(rule);
    expect(prompt).toContain(rule);
  }
});

// Usefulness: verifies the interactive instructions, headless prompt, and user docs state the
// status-read exception with one scope: the command `agent-loop role wait-checks`. No text widens
// the role rule beyond what the others allow (issue #348).
test("instructions, prompt, and user docs share the status-read exception scope", async () => {
  const scope = "and agent-loop role wait-checks is the only command it covers";
  const flat = (text) => text.replace(/`/g, "").replace(/\s+/g, " ");
  const readme = await readUserDocs();
  expect(flat(await readInstructions())).toContain(scope);
  expect(flat(gatedPrompt("claude"))).toContain(scope);
  expect(flat(readme)).toContain(scope);
  for (const text of [gatedPrompt("claude"), readme]) {
    expect(flat(text)).not.toMatch(/gh pr checks (?:and|or) [^.]*are the only commands/);
  }
});

// Usefulness: verifies the reference architecture section (docs/reference/architecture.md) states
// the same status-read exception as the prompt. `agent-loop role wait-checks` is the only command
// it covers, so no text keeps the older rule that allowed `gh pr checks` (issue #348). The
// exclusivity clause keeps "is the only command" whole, so a negated or widened claim fails.
test("the reference architecture rule names role wait-checks as the only exception command", async () => {
  const architecture = await readFile(
    join(dirname(instructionsPath), "reference/architecture.md"),
    "utf8",
  );
  const rule = architecture.split("\n").find((line) => line.startsWith("- **Orchestrator**"));
  expectRule(
    rule,
    /pull request check status/i,
    /`agent-loop role wait-checks`/,
    /status read is the only command (?:that )?the exception covers/i,
  );
  expect(rule).not.toContain("gh pr checks");
});

// Usefulness: verifies the interactive instructions state the same remote-write
// rule and the same status-read carve-out as the headless prompt (issue #422).
test("the interactive instructions forbid a remote write and allow a status read", async () => {
  const text = (await readInstructions()).replace(/\s+/g, " ");
  expect(text).toContain("Never write to GitHub or any remote");
  expect(text).toContain(
    "A status read, such as `agent-loop role wait-checks`, changes nothing, so it is not a write.",
  );
});

// Usefulness: verifies the user docs state that the runtime does not see a remote write (issue
// #422). They name both paths and state the connector write probe result (issue #496).
test("the user docs state the remote-write limit", async () => {
  const readme = (await readUserDocs()).replace(/\s+/g, " ");
  expect(readme).toContain(
    "the runtime does not detect a remote write in a reviewer or orchestrator turn",
  );
  expect(readme).toContain("Shell network.");
  expect(readme).toContain("`codex_apps`");
  expect(readme).toContain(
    "The `danger-full-access` mode, which a Codex reviewer with no sandbox runs under, posted the comment",
  );
});

// The refused-`--cwd` rule that both parent paths state the same way. It is the decision, not a
// repair procedure: a parent ends the run, and a maintainer decides what happens to the work tree.
// The mechanism behind it differs by parent. So only the decision, the qualification, and the three
// refused cases are pinned here. The test fails when either side drops them (issue #327).
const REFUSED_CWD_RULE = [
  "A refused `--cwd` is not the parent's to repair: end the run, name the path and the refusal in the reason, and leave the work tree to a maintainer, who decides whether to recreate it and start a new run.",
  "Abort only when a non-terminal run exists at the refused `--cwd`. With no run state there, from a refused init or a path that was never this run's, no run started, so report the refusal and do not abort. A run that is already terminal needs no abort.",
  "One rule covers every refused `--cwd`: a path that no longer exists, a path that is not inside a Git work tree, and an existing work tree path whose Git metadata is lost all report `--cwd must be inside a Git work tree: <path>`, so the reason names that path and that message.",
];

// Usefulness: verifies the interactive instructions and the headless prompt state the same
// refused-`--cwd` rule (issue #327). Neither parent path then sends a maintainer through a work
// tree repair that the runtime never asked for.
test("interactive instructions and headless prompt share the refused --cwd rule", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  for (const rule of REFUSED_CWD_RULE) {
    expect(instructions).toContain(rule);
    expect(prompt).toContain(rule);
  }
  // Neither text keeps the repair procedure or the unrecoverable claim. The only `git worktree`
  // commands the instructions may hold are the single creation command (#985), its no-remote form
  // (#1099), and the single removal command (#998) of "Work tree ownership": with both removed, no `git worktree` call is
  // left to add, repair, or recreate.
  expect(instructions.split(WORK_TREE_CREATE_COMMAND)).toHaveLength(2);
  expect(instructions.split(WORK_TREE_CREATE_NO_REMOTE_COMMAND)).toHaveLength(2);
  expect(instructions.split(WORK_TREE_REMOVE_COMMAND)).toHaveLength(2);
  expect(
    instructions
      .replace(WORK_TREE_CREATE_COMMAND, "")
      .replace(WORK_TREE_CREATE_NO_REMOTE_COMMAND, "")
      .replace(WORK_TREE_REMOVE_COMMAND, ""),
  ).not.toContain("git worktree");
  expect(prompt).not.toContain("git worktree");
  for (const gone of ["not recoverable", "unrecoverable"]) {
    expect(instructions).not.toContain(gone);
    expect(prompt).not.toContain(gone);
  }
});

// The refused-`--cwd` rule text of each parent text, pinned whole (whitespace-normalized) from the
// start of its enclosing section to the start of the next one: in the instructions the whole
// "Work tree ownership" section, from its heading to the next `## ` heading, and in the headless
// prompt the block that opens at "Map the report fields into the finish summary:" and ends before
// "User Task:". The pin is deliberately brittle: any added, removed, or reworded sentence in it,
// including a prose instruction that tells the parent to repair or recreate the work tree in any
// wording or position, fails until this test is edited on purpose (#991). Prose outside the
// sections is not scanned, so unrelated text is free to change.
const REMOVAL_PARAGRAPH =
  'When the run ends, remove the work tree with `git worktree remove --force "<work tree>"`, then check whether the folder still exists. On Windows, the remove can leave the folder when a turn ran `pnpm install`: it holds `node_modules` with junctions into the shared pnpm store and no file. When the folder remains, check that it holds only links and directories. On Windows, run `Get-ChildItem -LiteralPath "<work tree>" -Recurse -Force -Attributes "!Directory+!ReparsePoint"` in PowerShell. On POSIX, run `find "<work tree>" -not -type d -not -type l`. Each command includes hidden files and never descends into a link or a junction. Any path that it prints is a file: stop and leave the folder to a maintainer. When it prints nothing, delete the folder without following links: `cmd.exe /c rmdir /s /q "$($wt.Replace(\'/\', \'\\\'))"` in PowerShell, with the work tree path in `$wt`, `cmd.exe /c rmdir /s /q "<work tree>"` in cmd.exe, `MSYS_NO_PATHCONV=1 cmd.exe /c rmdir /s /q "$(cygpath -w "<work tree>")"` in Git Bash, `rm -rf "<work tree>"` on POSIX, which does not follow symbolic links. The cmd.exe forms need a path with backslashes, because `cmd.exe` reads a forward slash as a switch and fails with `Invalid switch`. Git prints work tree paths with forward slashes on Windows, so the PowerShell form converts the path. A harness PowerShell tool has refused the PowerShell form with `Remove-Item on system path \'/s\' is blocked`. The cause is not confirmed. Claude Code 2.1.310 in the bypass-permissions mode ran the form with no refusal on 2026-10-25, so the refusal can depend on the version or the permission mode. When it refuses, run the Git Bash form instead. Run the Windows delete as `cmd.exe /c rmdir`, because Git Bash resolves a bare `rmdir` to GNU rmdir, which rejects those switches. In Git Bash, keep `MSYS_NO_PATHCONV=1`, because MSYS path conversion rewrites the `/s` and `/q` switches, and `cmd.exe` then exits 0 and leaves the folder. Never use a recursive delete that follows junctions: it can damage the shared pnpm store.';

const REFUSED_CWD_BLOCKS = {
  instructions: {
    start: "## Work tree ownership",
    end: " ## Reference sections",
    text: [
      "## Work tree ownership",
      "The parent creates the run's work tree and owns it. Keep that work tree in place for the whole run, and never tell a worker to remove it: a worker turn pushes its branch and stops there, because every later dispatch of that run targets the same `--cwd`.",
      "Create the work tree with no upstream, so a plain `git push` of a worker cannot reach the default branch:",
      "```bash git worktree add --no-track -b <branch> <work tree> origin/<default> ```",
      "Without `--no-track`, the new branch gets the upstream `origin/<default>` when `branch.autoSetupMerge` is at its default. The worker sets the upstream to its own remote branch on the first push, with `git push -u origin <branch>`.",
      "A repository with no remote has no `origin/<default>`, so the command above fails. Use the local default branch as the base:",
      "```bash git worktree add --no-track -b <branch> <work tree> <default> ```",
      "In that repository, a worker commits in the work tree and never pushes, because there is no remote for `git push -u origin <branch>`. After `finish`, the parent merges the branch or hands it to the user.",
      "That run is not PR work, because no pull request can exist. Finish it with a plain `role finish` and no PR gate, after a reviewer `verdict: accept` with a `Checks` line on the latest changed state. Add `--require-accept` where it applies. Compare `reviewed.head` with the `workTree.head` of the last worker envelope. Never pass `--pr`, `--require-ci`, or `--compare-head`, never run `declare-pr`, and never set `unresolvedCompare`: each one concerns a PR head, and this run has none, so the #286 gap does not apply to it.",
      "The parent installs the dependencies of the work tree, and no worker or reviewer does. After you create the work tree and before the first dispatch, run the repository's lockfile install inside the work tree, for example `pnpm install --frozen-lockfile`. The work tree then has its own `node_modules` for every turn. Never link or junction the `node_modules` of another checkout into the work tree, and never run an install in another checkout: a tool such as `vp` can rewrite links in the `node_modules` that the junction points to.",
      '`dispatch` checks the work tree before it reads the run state, charges a step, or spawns a child, so a refused `--cwd` leaves the run as it was: the init call writes no state file, and a later dispatch charges no step, changes no lifecycle, and spawns no child. The envelope carries `status: "error"` with `--cwd must be inside a Git work tree: <path>`.',
      "A failed first turn keeps the session id its output printed, so the next dispatch resumes that session and the edits the failed turn left. When a resume fails because the CLI has no such session, the runtime clears the id and reruns the turn once as a first turn, with the worker preamble and the `Init task:` block. A reviewer rerun gets the `Init task:` block too. That rerun is part of the step the dispatch already charged: it charges no second step and adds no `turns` entry.",
      "When `--cwd` is a linked work tree, the init call copies the untracked local files of the main work tree that `--cwd` ignores (agent instructions, harness configuration, `.env`, and the other paths in [Local files in a linked work tree](reference/harness-entry-points.md#local-files-in-a-linked-work-tree)) into `--cwd`, before the first child turn. A file already in `--cwd` is never replaced, and no symlink is followed: a symlink in the main work tree is skipped and named. The init envelope reports the paths as `localFiles: {copied, skipped}`, by name only, and a path in `skipped` is untracked in the main work tree but not copied: the child does not have it. Do not read, print, or quote any copied file. The copy duplicates secrets such as `.env` into the run work tree, so remove that work tree when the run ends. Pass `--no-copy-local-files` on the init call to turn the copy off. It is an init field, so a later call cannot change it.",
      REMOVAL_PARAGRAPH,
      "When the task needs other ignored reference data of the main work tree, such as a downloaded specification directory, pass `--copy-local-path <relative path>` on the init call, once for each path. The path joins the copy and follows every rule above, and its files appear in `localFiles.copied`. The init refuses an absolute path, a path that leaves the main work tree or passes through a symlink or a junction, a path that holds a tracked file, a path that holds a file that is not ignored, and use with `--no-copy-local-files`. A refused init writes no state and spawns no child. It is an init field too, so a later call cannot change it, and `localFilesDiffer` covers the files.",
      "The copy runs once. A later dispatch never replaces or refreshes a copied file, but it compares each copied file with its source in the main work tree by hash and reports the names that differ as `localFilesDiffer: [...]` in the envelope. The key is absent when no copy differs. A copy differs when the main work tree changed the file after init, or when a turn changed the copy: the report does not tell which. When the key appears, check whether the main work tree holds a newer rule file, such as `AGENTS.md`, and tell the child to refresh that file by hand when it holds no turn edit. Never read, print, or quote the file to decide.",
      "A refused `--cwd` is not the parent's to repair: end the run, name the path and the refusal in the reason, and leave the work tree to a maintainer, who decides whether to recreate it and start a new run.",
      "Abort only when a non-terminal run exists at the refused `--cwd`. With no run state there, from a refused init or a path that was never this run's, no run started, so report the refusal and do not abort. A run that is already terminal needs no abort.",
      "One rule covers every refused `--cwd`: a path that no longer exists, a path that is not inside a Git work tree, and an existing work tree path whose Git metadata is lost all report `--cwd must be inside a Git work tree: <path>`, so the reason names that path and that message.",
      '```bash agent-loop role abort --cwd "<work tree>" \\ --reason "<work tree>: --cwd must be inside a Git work tree" ```',
      "`abort` reads only the state file, so it ends the run over a work tree that is gone or is not a Git work tree, and it writes nothing inside that path. It needs a non-terminal run at that path: a path with no run state is refused with `No run state for <path>`, and a terminal run is refused with `Run is already <lifecycle>.`, so neither is a command to run there. A maintainer who recreates the work tree starts a new run there: a run over an aborted work tree is not resumed, and the state file names the work tree, not the work in it.",
      "The headless loop states the same rule and cannot act on it: `agent-loop` snapshots its `--cwd` before and after every orchestrator turn, so a work tree in any of those three states ends the run on that snapshot failure before the orchestrator can act, and the run keeps no state file. A headless worker turn gets the ownership rule from the same file, because `runChild` builds the worker prompt there for both paths.",
    ].join(" "),
  },
  prompt: {
    start: "Map the report fields into the finish summary:",
    end: " User Task:",
    text: [
      "Map the report fields into the finish summary:",
      "- Carry each Deferred item forward from every worker or reviewer turn. An item leaves the list when a later worker turn reports it done and a later reviewer accept covers that state; record it in changed. The items that remain at finish go into deferred.",
      "- A reviewer accept can leave a criterion unverified, because the reviewer turn cannot run its check. Its Checks line reports the criterion as unverified, and its Deferred line lists it. Carry it into deferred, and name the unrun check in verified as not verified. Do not dispatch another turn to run that check, unless the task states that the check must pass in this run.",
      "- Reviewer Notes that no later turn addressed go into open.",
      "- Do not send an accepted note to the worker automatically. To act on a note, dispatch the worker for that change, then obtain another reviewer accept on the new state before finish.",
      "- In review-only mode, Blockers and Notes go into open, and reviewer Deferred items go into deferred. deferred holds out-of-scope items in every mode; open holds unresolved in-scope findings.",
      REFUSED_CWD_RULE[0],
      REFUSED_CWD_RULE[1],
      REFUSED_CWD_RULE[2],
      "A headless run cannot act on a refused `--cwd`: the runtime snapshots its `--cwd` before and after every orchestrator turn, so a work tree in any of those three states ends the run on that snapshot failure, and no turn of yours runs after it. A maintainer decides whether to recreate the work tree and start a new run.",
      "`dispatch --resume-interrupted` exits 1 and names the process when a live process still holds the Claude session of the role. Do not end that process. The maintainer ends it or waits for it.",
    ].join(" "),
  },
};

/** Asserts the text holds the pinned section exactly, from its start marker to its end marker. */
function expectRefusedCwdBlock(text, { start, end, text: pinned }) {
  for (const marker of [start, end]) {
    expect(text.split(marker), `${marker} must occur exactly once`).toHaveLength(2);
  }
  const from = text.indexOf(start);
  const stop = text.indexOf(end);
  expect(stop, "the end marker of the refused --cwd section precedes its start").toBeGreaterThan(
    from,
  );
  expect(text.slice(from, stop).trim()).toBe(pinned);
}

/** The interactive instructions and the headless prompt, whitespace collapsed. */
async function readParentTexts() {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  return { instructions, prompt };
}

// Usefulness: verifies both parent texts keep the refused-`--cwd` rule block as pinned, so the
// parent is never told to repair or recreate the work tree (#991). The rule sentence pin above
// misses an added sentence, and the `git worktree` ban misses prose.
test("refused --cwd rule block is unchanged in the instructions and the headless prompt", async () => {
  const texts = await readParentTexts();
  for (const [name, pin] of Object.entries(REFUSED_CWD_BLOCKS)) {
    expectRefusedCwdBlock(texts[name], pin);
  }
});

// Usefulness: verifies the pin fails on an instruction that tells the parent to recover the work
// tree, wherever it sits in the block and whatever verb or clause shape it uses, and passes on
// unrelated prose elsewhere in the text (#991).
test("refused --cwd pin fails on a recovery instruction and ignores unrelated prose", async () => {
  const texts = await readParentTexts();
  const [rule] = REFUSED_CWD_RULE;
  const [, second] = REFUSED_CWD_RULE;
  const RECOVERY_INSTRUCTION = "Recreate the work tree at the refused path before you abort.";
  // The first sentence of the earlier pin, the first text after the rule block, and the structural start.
  const BEFORE_OLD_PIN = {
    instructions: "Never read, print, or quote the file to decide.",
    prompt: "- In review-only mode,",
  };
  const AFTER_RULE_BLOCK = { instructions: " ## Reference sections", prompt: " User Task:" };
  const SECTION_START = {
    instructions: "## Work tree ownership",
    prompt: "Map the report fields into the finish summary:",
  };
  const unsafe = {
    "an earlier maintainer mention": (text) =>
      text.replace(
        second,
        `${second} A maintainer may be busy, so the parent recreates the work tree.`,
      ),
    "an unrelated negation": (text) =>
      text.replace(
        second,
        `${second} Do not wait; the parent repairs the work tree and dispatches again.`,
      ),
    "a verb outside any list": (text) =>
      text.replace(rule, `Regenerate the checkout at the refused path. ${rule}`),
    "an instruction after the block": (text) =>
      text.replace(
        "A maintainer decides whether to recreate the work tree and start a new run.",
        "A maintainer decides whether to recreate the work tree and start a new run. Restore the Git metadata of the path before you abort.",
      ),
    "a negation dropped": (text) =>
      text.replace("is not the parent's to repair", "is the parent's to repair"),
    "a removed rule": (text) => text.replace(rule, ""),
    "an instruction directly before the first sentence of the old pin": (text, key) =>
      text.replace(BEFORE_OLD_PIN[key], `${RECOVERY_INSTRUCTION} ${BEFORE_OLD_PIN[key]}`),
    "an instruction directly before the next section": (text, key) =>
      text.replace(AFTER_RULE_BLOCK[key], `${RECOVERY_INSTRUCTION} ${AFTER_RULE_BLOCK[key]}`),
    "a start marker duplicated after the span": (text, key) => `${text} ${SECTION_START[key]}`,
    "an end marker duplicated after the span": (text, key) => `${text} ${AFTER_RULE_BLOCK[key]}`,
    "an instruction right after the section heading": (text, key) =>
      text.replace(SECTION_START[key], `${SECTION_START[key]} ${RECOVERY_INSTRUCTION}`),
  };
  for (const [name, mutate] of Object.entries(unsafe)) {
    for (const [key, pin] of Object.entries(REFUSED_CWD_BLOCKS)) {
      const mutated = mutate(texts[key], key);
      // A mutation that does not apply to a text is not a case for it.
      if (mutated === texts[key]) continue;
      expect(() => expectRefusedCwdBlock(mutated, pin), `${name} in ${key}`).toThrow();
    }
  }
  const unrelated = [
    "After compaction, restore the session from the state file.",
    "The module imports the helper from the path `src/lib/helper.mjs`.",
  ].join(" ");
  for (const [key, pin] of Object.entries(REFUSED_CWD_BLOCKS)) {
    expect(() =>
      expectRefusedCwdBlock(`${unrelated} ${texts[key]} ${unrelated}`, pin),
    ).not.toThrow();
  }
});

// Usefulness: verifies the work tree creation command sets no upstream (#985), so a plain
// `git push` of a worker cannot reach the default branch. No other test reads this section.
test("instructions create the run work tree without an upstream and set it on the first push", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  expect(instructions).toContain(
    "git worktree add --no-track -b <branch> <work tree> origin/<default>",
  );
  expect(instructions).toContain("git push -u origin <branch>");
});

// Usefulness: verifies the instructions give the base ref and the worker push rule of a repository
// with no remote (#1099). Without it, an interactive parent improvises both, and the origin form fails.
test("instructions state the no-remote work tree base and worker commit-only rule", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  expect(instructions).toContain(WORK_TREE_CREATE_NO_REMOTE_COMMAND);
  expect(instructions).toContain("a worker commits in the work tree and never pushes");
  expect(instructions).toContain("the parent merges the branch or hands it to the user");
  expect(instructions).toContain("Finish it with a plain `role finish` and no PR gate");
  expect(instructions).toContain(
    "Never pass `--pr`, `--require-ci`, or `--compare-head`, never run `declare-pr`, and never set `unresolvedCompare`",
  );
});

// Usefulness: verifies requirement "the parent owns the dependency install of a run work tree and
// no run work tree links another checkout's node_modules" (#1057), in the instructions and in the
// headless prompt. Without it, a worker links the main checkout's `node_modules` and a `vp` run
// rewrites links there.
test("instructions and headless prompt name the work tree install owner and bar a foreign node_modules", async () => {
  const { instructions, prompt } = await readParentTexts();
  const ownership = instructions.slice(
    instructions.indexOf("## Work tree ownership"),
    instructions.indexOf(" ## Reference sections"),
  );
  expect(ownership).toContain(
    "After you create the work tree and before the first dispatch, run the repository's lockfile install inside the work tree, for example `pnpm install --frozen-lockfile`.",
  );
  expect(ownership).toContain(
    "Never link or junction the `node_modules` of another checkout into the work tree, and never run an install in another checkout",
  );
  expect(prompt).toContain(
    "the operator that created it ran the repository's lockfile install in it before the first dispatch, and no worker or reviewer installs them.",
  );
  expect(prompt).toContain(
    "Never tell a worker to link or junction the `node_modules` of another checkout into the work tree, or to run an install in another checkout.",
  );
});

// Usefulness: verifies the instructions name the work tree removal step and a delete that never
// follows a junction or a symlink on each platform (#998). Without it, a parent can delete the
// leftover `node_modules` folder through pnpm junctions and damage the shared store.
test("instructions remove the run work tree without following links", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  expect(instructions).toContain(WORK_TREE_REMOVE_COMMAND);
  // The Windows delete has one form for PowerShell or cmd.exe and one for Git Bash, where MSYS
  // path conversion rewrites the `/s` and `/q` switches unless it is off.
  expect(instructions).toContain('cmd.exe /c rmdir /s /q "<work tree>"');
  // The PowerShell form converts a forward-slash path (#1023), because cmd.exe reads `/` as a
  // switch, and the text names the Git Bash form as the fallback for a harness refusal.
  expect(instructions).toContain("cmd.exe /c rmdir /s /q \"$($wt.Replace('/', '\\'))\"");
  expect(instructions).toContain("When it refuses, run the Git Bash form instead.");
  expect(instructions).toContain(
    'MSYS_NO_PATHCONV=1 cmd.exe /c rmdir /s /q "$(cygpath -w "<work tree>")"',
  );
  expect(instructions).toContain('rm -rf "<work tree>"');
  expect(instructions).toContain("Never use a recursive delete that follows junctions");
  // The leftover-folder check lists any entry that is not a link or a directory, hidden files
  // included, and never descends into a link.
  expect(instructions).toContain(
    'Get-ChildItem -LiteralPath "<work tree>" -Recurse -Force -Attributes "!Directory+!ReparsePoint"',
  );
  expect(instructions).toContain('find "<work tree>" -not -type d -not -type l');
});

// Usefulness: verifies requirement "the instructions state the allowed keys of run_worker,
// run_reviewer, and abort" (#1034), with the same split as the headless prompt, so a parent never
// sends a key that the runtime refuses.
test("instructions state the allowed keys of the dispatch and abort actions", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  expectRule(
    instructions,
    /`run_worker` and `run_reviewer` actions allow only `action` and `prompt`/,
  );
  expectRule(instructions, /`abort` action allows only `action` and `reason`/);
  expectRule(instructions, /any other key is refused/i, /names each unknown key/i);
});

// Usefulness: verifies the interactive instructions and the headless prompt state the same
// held-session rule (#671). Neither parent ends a live holder of a Claude session that
// `--resume-interrupted` refused on.
test("interactive instructions and headless prompt share the held-session rule", async () => {
  const rule =
    "`dispatch --resume-interrupted` exits 1 and names the process when a live process still holds the Claude session of the role. Do not end that process. The maintainer ends it or waits for it.";
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  expect(instructions).toContain(rule);
  expect(prompt).toContain(rule);
});

// Usefulness: verifies the interactive instructions and the headless prompt state the
// supplied-status rule the same way (issue #320 review). The two paths resolve the same rule for a
// parent. If a statement drifts, it tells one of them that the reviewer still reads the checks.
test("interactive instructions and headless prompt state the supplied-status rule alike", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
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

// Usefulness: verifies the two surfaces state the supplied-status rule in the same order and with
// the same conditions (issue #320 review, second round). A parent reading the instructions and an
// orchestrator reading the prompt then resolve one rule.
test("the supplied-status rule states the same conditions in both surfaces", async () => {
  const instructions = (await readInstructions()).replace(/\s+/g, " ");
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

// Usefulness: verifies the qualification is checked on the interactive
// instructions too, since the two surfaces must state the same rule
// (issue #320 review, fourth round).
test("the instructions qualify the only-check-read claim the same way", async () => {
  const instructions = await readInstructions();
  const lines = instructions.split("\n").filter((line) => /only check read/i.test(line));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(/enforc/i);
    expect(line).toMatch(/advisory/i);
  }
});

// Documentation of the opt-in Codex reviewer sandbox (issue #421, ADR 0019). Each test asserts
// the content a reader relies on, as a short phrase, so a same-meaning reword passes.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const adr19 = "adr/0019-opt-in-workspace-write-sandbox-for-the-codex-reviewer.md";

const readRepoFile = (path) => readFile(join(repoRoot, path), "utf8");

// The `--help` text, read from one CLI process for the whole file.
let helpText;
const readHelpText = () =>
  (helpText ??= execa("node", [join(repoRoot, "src/cli.mjs"), "--help"]).then(
    (result) => result.stdout,
  ));

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

// Usefulness: verifies the user docs and the orchestrator instructions describe the opt-in as ADR
// 0019 does. The text names the flag, the sandbox mode, the network option, the ADR, and each gap.
test("the user docs describe the reviewer sandbox opt-in consistently with ADR 0019", async () => {
  const text = await readUserDocs();
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

// Usefulness: verifies every surface that states the network limit says what it covers: the shell
// commands that the sandbox runs. No surface claims that it blocks model-side tools such as
// web_search. A reader never takes the limit for a block on every channel.
test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["ADR 0019", () => readRepoFile(adr19)],
  ["--help", readHelpText],
  ["reviewer prompt", async () => reviewerPrompt("x", null, null, "workspace-write")],
  [
    "orchestrator prompt",
    async () => initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox: "workspace-write" }),
  ],
])("%s qualifies the sandbox network limit as shell commands only", async (_name, load) => {
  const text = await load();
  expect(text).toMatch(/shell commands/i);
  expect(text).toMatch(/model-side tools?|web_search|web search/i);
});

// Usefulness: verifies ADR 0019 supersedes ADR 0001 in both directions and in the index. It
// restates the decisions of ADR 0001 that still hold, so no live decision is lost.
test("ADR 0019 supersedes ADR 0001 and restates what still holds", async () => {
  const adr1 = await readRepoFile("adr/0001-hybrid-orchestrator-runtime.md");
  const text = await readRepoFile(adr19);
  const index = await readRepoFile("adr/README.md");
  expect(adr1).toMatch(/## Status\s+superseded/);
  expect(adr1).toMatch(/Superseded by \[ADR 0019[^\]]*\]\(0019-/);
  expect(text).toMatch(/## Status\s+partially-superseded/);
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
  expect(row("0019")).toMatch(/\|\s*partially-superseded\s*\|/);
  expect(row("0019")).toMatch(/Supersedes ADR 0001/);
});

// Usefulness: verifies the reviewer prompt, the user docs, the orchestrator instructions, the other
// docs, the help text, and ADR 0019 carry no unqualified denial. The prompt and the docs then state
// one rule about what the Codex sandbox blocks.
test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["docs/parent-guard.md", () => readRepoFile("docs/parent-guard.md")],
  ["ADR 0019", () => readRepoFile(adr19)],
  ["--help", readHelpText],
  ["no-mode reviewer prompt", async () => reviewerPrompt("x", null, null, null)],
  ["no-sandbox reviewer prompt", async () => reviewerPrompt("x", null, null, "none")],
  ["read-only reviewer prompt", async () => reviewerPrompt("x", null, null, "read-only")],
  [
    "workspace-write reviewer prompt",
    async () => reviewerPrompt("x", null, null, "workspace-write"),
  ],
])("%s qualifies every network denial", async (_name, load) => {
  expect(unqualifiedDenials(await load())).toEqual([]);
});

// Usefulness: verifies requirement "no surface calls the Codex reviewer read-only or sandboxed by
// default" (ADR 0038). Each stale phrase named the old default or the old network rule, and was
// removed on purpose. A restored phrase fails here. A reword that keeps the meaning passes.
test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["--help", readHelpText],
  [
    "the headless orchestrator prompt",
    async () => initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox: "none" }),
  ],
])("%s does not state the old Codex reviewer default", async (_name, load) => {
  const text = (await load()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/reviewer \(read-only\)/);
  expect(text).not.toMatch(/reviews? the repository in read-only mode/i);
  expect(text).not.toMatch(/reviewer: Read-only inspector/i);
  expect(text).not.toMatch(/A Codex reviewer turn runs with `sandbox_mode="read-only"`/);
  expect(text).not.toMatch(/The default stays `read-only`/);
  expect(text).not.toMatch(/Codex needs no shell denial, except/);
  expect(text).not.toMatch(/When both CLIs are `codex`, no turn can read the checks/);
  expect(text).not.toMatch(/`codex` does not: its sandbox blocks/);
});

// Usefulness: verifies the user docs and --help state the default and both opt-ins in one place
// each reader looks. The new default is then not only in the ADR (ADR 0038).
test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["--help", readHelpText],
])("%s states the no-sandbox default and the two opt-in modes", async (_name, load) => {
  const text = (await load()).replace(/\s+/g, " ");
  expect(text).toMatch(/no sandbox/);
  expect(text).toContain("--reviewer-sandbox");
  expect(text).toContain("read-only");
  expect(text).toContain("workspace-write");
});

// Usefulness: verifies requirement "every surface that states the reviewer file-change rule states
// the scoped rule, not a blanket ban" (issue #837). A reviewer or an operator reading the README,
// the architecture reference, or the orchestrator role list is then not told that a test run with
// ignored output is forbidden. A restored blanket phrase fails here.
const REVIEWER_SCOPE =
  "must not change a tracked file, an unignored untracked file (a cache included), or Git state; writes only to ignored paths or temporary files outside the repository are allowed";

test.each([
  ["README.md", () => readRepoFile("README.md")],
  ["docs/reference/architecture.md", () => readRepoFile("docs/reference/architecture.md")],
  [
    "the headless orchestrator prompt",
    async () => initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox: "none" }),
  ],
])("%s states the scoped reviewer file-change rule", async (_name, load) => {
  const text = (await load()).replace(/\s+/g, " ");
  expect(text).toContain(REVIEWER_SCOPE);
});

test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readInstructions()],
  ["--help", readHelpText],
  [
    "the headless orchestrator prompt",
    async () => initialPrompt({ task: "t", maxSteps: 5, reviewerSandbox: "none" }),
  ],
])("%s carries no blanket reviewer file ban", async (_name, load) => {
  const text = (await load()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/must not (?:edit|change) (?:any )?files\b/);
  expect(text).not.toContain("reviewer (must not edit)");
  expect(text).not.toMatch(/Agent that reviews the repository \(read-only;/);
});

// Usefulness: verifies the interactive instructions tell the parent to restate every operator
// decision made after init in the next reviewer prompt, so the reviewer does not reject a
// worker change that the operator approved (issue #1038). The existing restated-spec rule does
// not cover it: a decision is a fact about the spec, not a pass condition.
test("docs/orchestrator-instructions.md relays operator decisions to the reviewer", async () => {
  const text = (await readInstructions()).replace(/\s+/g, " ");
  expectRule(
    text,
    /restate every operator decision made after init/i,
    /next reviewer prompt/i,
    /worker prompt that carries it/i,
  );
});

// Usefulness: verifies the core stays within one read of the Claude Code read tool (25,000 token
// cap, #1061). The byte bound leaves headroom at the density that the cap showed in #1055 (870
// lines of 1581 for about 62 KB). A larger core makes the parent read the file by pages again.
test("the core instructions stay within one read of the read tool", async () => {
  const { size } = await stat(instructionsPath);
  expect(size).toBeLessThanOrEqual(50_000);
});

// Usefulness: verifies the core names each reference section with the condition that makes the
// parent read it (#1061). A section that the core never names is never read, so its rules would
// silently drop out of a run. The check also rejects a link whose target does not exist.
test("the core names every reference section and when to read it", async () => {
  const core = await readFile(instructionsPath, "utf8");
  const listing = core.slice(core.indexOf("## Reference sections"));
  const entries = listing.split("\n- [").slice(1);
  for (const name of await referenceSectionNames()) {
    const entry = entries.find((part) => part.includes(`(orchestrator/${name})`));
    expect(entry, `${name} is not named in the Reference sections list`).toBeDefined();
    expect(entry.replace(/\s+/g, " "), `${name} has no condition`).toMatch(
      /read it .*\b(when|before)\b/,
    );
  }
  for (const [, target] of core.matchAll(/\]\((orchestrator\/[^)#]+)\)/g)) {
    await expect(readFile(join(dirname(instructionsPath), target), "utf8")).resolves.toBeTruthy();
  }
});

// Usefulness: verifies each reference section links back to the core and every relative link in
// it resolves, so the split files stay reachable from one another and from the core (#1061).
test("each reference section links back to the core and its relative links resolve", async () => {
  for (const name of await referenceSectionNames()) {
    const text = await readFile(join(referenceSectionsDir, name), "utf8");
    expect(text, name).toContain("](../orchestrator-instructions.md)");
    for (const [, target] of text.matchAll(/\]\(((?:\.\.?\/|[a-z-]+\.md)[^)#]*)\)/g)) {
      await expect(
        readFile(join(referenceSectionsDir, target), "utf8"),
        `${name} -> ${target}`,
      ).resolves.toBeTruthy();
    }
  }
});

// Usefulness: verifies the read trigger for `shellDenied` covers a worker envelope as well as a
// reviewer envelope, and fixes the timing as before the next dispatch (#1061 review). A refused
// worker command makes its reported checks unreliable, so a parent that reads the rule only after a
// reviewer envelope would dispatch the reviewer on the strength of an unrun check.
test("the core tells the parent to read the shellDenied rule after any worker or reviewer envelope", async () => {
  const core = await readFile(instructionsPath, "utf8");
  const listing = core.slice(core.indexOf("## Reference sections"));
  const entry = listing
    .split("\n- [")
    .find((part) => part.includes("(orchestrator/reviewer-evidence.md)"))
    .replace(/\s+/g, " ");
  expectRule(entry, /worker or reviewer envelope[^.]*`shellDenied`/i, /before the next dispatch/i);
  const section = await readFile(join(referenceSectionsDir, "reviewer-evidence.md"), "utf8");
  expectRule(
    section.replace(/\s+/g, " "),
    /worker or reviewer envelope[^.]*`shellDenied`/i,
    /before the next dispatch/i,
  );
});
