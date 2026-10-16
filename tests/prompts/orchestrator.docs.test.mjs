import { readdir, readFile } from "node:fs/promises";
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
];

// Usefulness: verifies the interactive instructions and the headless prompt state the same
// reviewed-state parent rules (issue #217, issue #252, issue #328). The two parent paths never
// diverge. The reviewer-Checks gate rule uses the same presence check as the gate test. A reword
// keeps the parity check, and a removal breaks it (issue #318).
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
  const instructions = await readFile(instructionsPath, "utf8");
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
  const instructions = await readFile(instructionsPath, "utf8");
  for (const text of [prompt, instructions]) {
    expectRule(text, /noRequiredChecks/, /dispatch the reviewer/i, /never record/i);
  }
});

// The surfaces that state the empty-union rule of the gate. The reviewer found them contradicting
// each other, so one rule is asserted on each. Only an allowlisted reply proves an absence, and a
// private Free-plan repository must omit `--pr`. Usefulness: verifies every surface states the same
// rule (#336 review). An orchestrator reading one is then not told that a run passes on a branch
// that the gate refuses.
const RULE_SURFACES = [
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
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
  expect(flat(await readFile(instructionsPath, "utf8"))).toContain(scope);
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
  const text = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  expect(text).toContain("Never write to GitHub or any remote");
  expect(text).toContain(
    "A status read, such as `agent-loop role wait-checks`, changes nothing, so it is not a write.",
  );
});

// Usefulness: verifies the user docs state that the runtime does not see a remote write (issue
// #422). They name both paths and say that the connector write was not probed.
test("the user docs state the remote-write limit", async () => {
  const readme = (await readUserDocs()).replace(/\s+/g, " ");
  expect(readme).toContain(
    "the runtime does not detect a remote write in a reviewer or orchestrator turn",
  );
  expect(readme).toContain("Shell network.");
  expect(readme).toContain("`codex_apps`");
  expect(readme).toContain("A write through those tools was not probed");
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

// Usefulness: verifies the interactive instructions and the headless prompt state the same
// held-session rule (#671). Neither parent ends a live holder of a Claude session that
// `--resume-interrupted` refused on.
test("interactive instructions and headless prompt share the held-session rule", async () => {
  const rule =
    "`dispatch --resume-interrupted` exits 1 and names the process when a live process still holds the Claude session of the role. Do not end that process. The maintainer ends it or waits for it.";
  const instructions = (await readFile(instructionsPath, "utf8")).replace(/\s+/g, " ");
  const prompt = initialPrompt({ task: "Implement feature X", maxSteps: 10 }).replace(/\s+/g, " ");
  expect(instructions).toContain(rule);
  expect(prompt).toContain(rule);
});

// Usefulness: verifies the interactive instructions and the headless prompt state the
// supplied-status rule the same way (issue #320 review). The two paths resolve the same rule for a
// parent. If a statement drifts, it tells one of them that the reviewer still reads the checks.
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

// Usefulness: verifies the two surfaces state the supplied-status rule in the same order and with
// the same conditions (issue #320 review, second round). A parent reading the instructions and an
// orchestrator reading the prompt then resolve one rule.
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
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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

// Usefulness: verifies the reviewer prompt, the user docs, the orchestrator instructions, the other
// docs, the help text, and ADR 0019 carry no unqualified denial. The prompt and the docs then state
// one rule about what the Codex sandbox blocks.
test.each([
  ["the user docs", readUserDocs],
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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
  ["docs/orchestrator-instructions.md", () => readFile(instructionsPath, "utf8")],
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
