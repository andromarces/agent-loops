import { access } from "node:fs/promises";
import { expect, test } from "vite-plus/test";
import { parseReportBlock } from "../../src/lib/report.mjs";
import { workerPrompt } from "../../src/prompts/worker.mjs";
import { NAMED_TARGET, commitTargets } from "./orchestrator-helpers.mjs";

// A label line at column 0, for example
// `Checks: the commands that ran and their results, or "none". One line.`
const LABEL_LINE = /^([A-Z][A-Za-z]*):\s/;

// The closing block template the prompt renders: the blank-line separated
// paragraph that opens with a `Conclusion:` label, which is where the parser
// starts the block too. Only that paragraph is the block, so label text in the
// role bullets or in the task cannot stand in for a label the block dropped.
function closingBlockTemplate(prompt) {
  const block = prompt.split(/\n\s*\n/).find((text) => /^Conclusion:\s/m.test(text));
  if (!block) {
    throw new Error("the worker prompt renders no closing block template");
  }
  return block;
}

// A worker response written to the closing block: each label line holds the
// value the caller supplies, and every other line of the template is kept as
// written, so the sample parses under the same rules the prompt describes.
function workerResponse(block, values = {}) {
  return block
    .split("\n")
    .map((line) => {
      const label = LABEL_LINE.exec(line)?.[1];
      return label ? `${label}: ${values[label] ?? `${label} value.`}` : line;
    })
    .join("\n");
}

// Usefulness: verifies the first worker turn asks for the closing report block
// (conclusion, why, blockers) plus the optional notes and deferred labels, so
// the orchestrator receives reasoning and out-of-scope items, not only an
// outcome (issue #49, issue #214).
test("first worker turn requires the closing report block", () => {
  const prompt = workerPrompt("do the task", true);
  expect(prompt).toContain("do the task");
  expect(prompt).toContain("Conclusion:");
  expect(prompt).toContain("Why:");
  expect(prompt).toContain("Blockers:");
  expect(prompt).toContain("Notes:");
  expect(prompt).toContain("Deferred:");
});

// Usefulness: verifies a worker response written to the closing block the
// prompt renders carries a Checks value the parser reads into report.checks, so
// a worker reports the commands it ran and their results instead of leaving the
// orchestrator with a null checks field. The sample comes from the block alone,
// so a reword of the block keeps the assertion and a Checks label the block
// drops or renames fails it even when the word appears elsewhere in the prompt
// (issue #310, issue #318).
test("a worker response written to the prompt block parses a Checks value", () => {
  const block = closingBlockTemplate(workerPrompt("do the task", true));
  const report = parseReportBlock(workerResponse(block, { Checks: "pnpm test passed" }));
  expect(report).not.toBeNull();
  expect(report.checks).toBe("pnpm test passed");
});

// The commit instruction on the supplied branch, with BRANCH standing in for the
// branch the task supplied, so the rule may name it or point at it.
const COMMIT_ON_SUPPLIED_BRANCH =
  /commit[^.;]{0,60}?\b(?:on|onto)\s+(?:(?:the|that|this|your)\s+branch|BRANCH)/i;

/** Asserts the rule commits and pushes on the branch the dispatcher supplied. */
function expectBranchTargets(text, branch) {
  // The dispatcher supplies the branch, so the prompt must carry it.
  expect(text).toContain(branch);
  const flat = text.replace(/\s+/g, " ");
  // The commit instruction targets the supplied branch, named outright or pointed
  // at, and the push follows the commit, so dropping either fails.
  expect(flat, "the rule states no commit on the supplied branch").toMatch(
    new RegExp(COMMIT_ON_SUPPLIED_BRANCH.source.replace("BRANCH", branch), "i"),
  );
  expect(flat, "the rule states no push instruction").toMatch(/commit[^.;]{0,120}?\bpush\b/i);
  for (const target of commitTargets(flat)) {
    // A back-reference points at the supplied branch; a name of its own fails.
    expect(
      target === branch || !NAMED_TARGET.test(target),
      `the rule commits on ${target}, not the supplied branch`,
    ).toBe(true);
  }
}

// Usefulness: verifies the first worker turn tells the worker to commit and push
// on the branch the dispatcher supplied, so the commit lands where the reviewer
// will look and the PR head matches the reviewed head. The prompt is built with a
// unique sentinel branch, so a target naming any other branch, including a bare
// `main` or `origin/main`, fails (issue #252, issue #328).
test("first worker turn commits and pushes on the branch the dispatcher named", () => {
  const branch = "sentinel/328-branch-under-test";
  expectBranchTargets(workerPrompt(`land the change on ${branch}`, true), branch);
});

// Usefulness: verifies the first worker turn states that the work tree belongs to
// the parent and must not be removed, moved, or switched, so a worker cannot
// leave every later dispatch of that run targeting a path with no checkout
// (issue #327).
test("first worker turn states that the work tree belongs to the parent", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "The work tree this turn runs in belongs to the parent. Never remove, move, or switch it,",
  );
});

// Usefulness: verifies the first worker turn forbids a background watcher and
// requires the closing block for the whole turn as the last message after a late
// event, so the one message the runtime parses never describes only the event
// (issue #433).
test("first worker turn keeps the closing block as the last message", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain("Start no background watcher, Monitor, or poller.");
  expect(prompt).toContain(
    "If a late event arrives after the closing block, end again with the closing block for the whole turn.",
  );
});

// Usefulness: verifies requirement "a worker states each result the parent needs inside the closing
// block" (issue #976): the parent reads only the block, so a pointer to text above it loses the
// result. The reviewer has the same rule for blockers (issue #434).
test("first worker turn requires each result inside the closing block", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "State every result the parent needs, such as findings, drafts, decisions, and open questions, inside the closing block, in full on its label line.",
  );
  expect(prompt).toContain(
    'Never refer to text outside the block, for example "the decisions above", because the parent reads only the block.',
  );
});

// Usefulness: verifies later worker turns carry the task text and no preamble; the session already
// holds the instructions. The one rule they repeat is covered by the PR body test.
test("later worker turns pass the prompt without the preamble", () => {
  const prompt = workerPrompt("next step", false);
  expect(prompt.startsWith("next step")).toBe(true);
  expect(prompt).not.toContain("You are the implementation agent");
});

// Usefulness: verifies requirement "the worker contract states that a shell command can be refused" (issue #713): a refused command is named in the report, not reported as run.
test("first worker turn tells a worker to name a refused command in the report", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "If the CLI refuses a command, never report it as run. Name the refusal in Checks and Blockers.",
  );
});

// Usefulness: verifies a worker prompt built from text that holds a line separator renders none
// raw, on the first turn and later turns (issue #761).
test("workerPrompt renders no raw line separator", () => {
  for (const firstTurn of [true, false]) {
    const prompt = workerPrompt("fix\u{2028}this\u{2029}now\u0085", firstTurn);
    for (const raw of ["\u{2028}", "\u{2029}", "\u0085"]) {
      expect(prompt).not.toContain(raw);
    }
  }
});

// Usefulness: verifies requirement "a worker never ends a process by name or command-line match" (issue #762): a worker that kills by match can end its own dispatcher and CLI.
test("first worker turn forbids ending a process by name or command-line match", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "Never stop, kill, or signal a process that your own commands did not start, and never select processes by name or by a command-line match.",
  );
  expect(prompt).toContain("End only the exact PIDs your own commands started.");
});

// Usefulness: verifies requirement "a worker runs a full suite only through the test slot" (issue
// #848): the first turn names the wrapper of this run, built from the Node binary and the CLI
// script, so the rule works where `agent-loop` is not on PATH.
test("first worker turn routes a full suite through the test slot wrapper of this run", async () => {
  const prompt = workerPrompt("do the task", true);
  expect(prompt).toMatch(/Run a targeted test file through the test slot wrapper with --if-held/);
  expect(prompt).toContain("or rely on the required CI checks");
  const match = prompt.match(/"([^"]+)" "([^"]+)" test-slot -- "<full suite command>"/);
  expect(match).not.toBeNull();
  expect(match[1]).toBe(process.execPath.replaceAll("\\", "/"));
  await access(match[2]);
});

// Usefulness: verifies requirement "a worker starts no load generator or process that outlives the turn" (issue #934): an unguarded busy-loop script left 64 loops running after an interrupt.
test("first worker turn bars load generators and processes that outlive the turn", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "Start no CPU or memory load generator, no busy loop, and no detached or background process that can outlive the turn. Use the required CI checks as the evidence under load.",
  );
});

// Usefulness: verifies requirement "a PR-work worker leaves the work tree clean" (issue #910): the
// worker commits or discards every change before the closing block, so a leftover change is not
// found only after a reviewer turn.
test("first worker turn requires a clean work tree for PR work", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "For PR work, before the closing block, `git status --porcelain` must be empty, ignored files aside. Commit or discard every change, and name in Notes any change that you keep on purpose.",
  );
});

// Usefulness: verifies acceptance #902 — the worker is told to remove the temporary files it
// creates outside the work tree and to name any it could not remove, because a PR body file in the
// system temporary directory outlives the turn and can hold confidential text.
test("first worker turn tells the worker to remove temporary files it created outside the work tree", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "Before the closing block, remove every temporary file or directory that this turn created outside the work tree, and name in Notes any that you could not remove.",
  );
});

// Usefulness: verifies requirement "a worker updates the PR body after a push to a branch with an open
// pull request" (issue #1002): without it the body describes the first head, not the head the reviewer
// accepts, and the rule bars a revision log so the body stays a description, not a diary.
test("first worker turn tells the worker to update the PR body after a push", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment.",
  );
});

// Usefulness: verifies requirement "every worker turn that can push a fix carries the PR body rule"
// (issue #1002): a resumed turn, including one in a replacement conversation that got no preamble
// yet, is the turn that pushes a fix, so the rule must reach it.
test("later worker turns carry the PR body update rule", () => {
  const prompt = workerPrompt("fix the reviewer finding", false).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "After each push, if the branch has an open pull request, update the pull request body in place so that it describes the pushed head. Add no revision log to the body or to a comment.",
  );
});

// Usefulness: verifies requirement "a run work tree uses its own node_modules and never links
// another checkout's" (issue #1057): a junction to the main checkout let a `vp` run rewrite links
// there. The probe copy test below covers a different target, the copy.
test("first worker turn bars linking another checkout node_modules into the work tree", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "Use the own `node_modules` of this work tree, which the parent installed before the first dispatch. Never link or junction the `node_modules` of another checkout into this work tree, and never run an install in another checkout.",
  );
});

// Usefulness: verifies requirement "a worker probe copy reuses the work tree node_modules" (issue
// #1026): a tool such as `vp` installs into the shared package store when the copy has no usable
// `node_modules`, and every work tree that links the store sees that write.
test("first worker turn tells a probe copy to link the work tree node_modules and run no install", () => {
  const prompt = workerPrompt("do the task", true).replace(/\s+/g, " ");
  expect(prompt).toContain(
    "When a probe copies the repository, for example to run old source, link the `node_modules` of the work tree into the copy, with a junction on Windows or a symlink elsewhere, and run no dependency install, repair, or update there.",
  );
  expect(prompt).toContain(
    "A tool such as `vp` installs into the shared package store when it finds no usable `node_modules`, and every work tree that links the store sees that write.",
  );
});
