import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory (`untrackedFilesGit` and `cleanRepoGit` in git-helpers.mjs), so every
// case in this file runs the real snapshot code without starting a `git` process.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { runChild } from "../src/child-turn.mjs";
import { acceptanceFailure } from "../src/lib/report.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createCleanRepoDir, untrackedFilesGit } from "./git-helpers.mjs";

// A response whose closing block has no Blockers label, so it parses to null.
const INVALID = "Conclusion: done\nWhy: tests pass\nChecks: npm test";
const REPAIRED = [
  "Conclusion: done",
  "Why: tests pass",
  "Blockers: none",
  "Checks: npm test",
  "Notes: none",
  "Deferred: none",
].join("\n");
const REPAIRED_REVIEW = `${REPAIRED}\nVerdict: accept`;
// A table pair makes the block unparseable, while the labels and Verdict line stay readable.
const TABLE = "| a | b |\n| --- | --- |";
const REJECTED = `Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test\n${TABLE}\nVerdict: reject`;
const UNVERDICTED = `Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test\n${TABLE}`;
const ACCEPT_NO_CHECKS = `Conclusion: done\nWhy: tests pass\nBlockers: none\n${TABLE}\nVerdict: accept`;
// A table after the Verdict line still makes the report null, without adding label content.
const AFTER_VERDICT_TABLE = `Verdict: accept\n${TABLE}`;
const EMPTY_REQUIRED = `Conclusion: done\nWhy:\nBlockers: none\nChecks: npm test\n${AFTER_VERDICT_TABLE}`;
const EMPTY_REQUIRED_REPAIRED =
  "Conclusion: done\nWhy: none\nBlockers: none\nChecks: npm test\nVerdict: accept";
const EMPTY_CHECKS = `Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks:\n${AFTER_VERDICT_TABLE}`;
const EMPTY_CHECKS_REPAIRED =
  "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: none\nVerdict: accept";
const CHANGED = "Conclusion: different\nWhy: changed\nBlockers: none\nChecks: npm test";
// A star-list finding is a list the parser rejects, but the repair must still keep its content.
const STAR_WHY = "Conclusion: done\nWhy:\n* first\n* second\nBlockers: none\nChecks: npm test";
const STAR_WHY_REPAIRED =
  "Conclusion: done\nWhy:\n- first\n- second\nBlockers: none\nChecks: npm test";
const STAR_WHY_DROPPED = "Conclusion: done\nWhy: none\nBlockers: none\nChecks: npm test";
const STAR_CHECKS =
  "Conclusion: done\nWhy: ok\nBlockers: none\nChecks: npm test\n* npm run lint failed";
const STAR_CHECKS_DROPPED = "Conclusion: done\nWhy: ok\nBlockers: none\nChecks: npm test";
const NUMBERED_WHY =
  "Conclusion: done\nWhy:\n1. first\n2. second\nBlockers: none\nChecks: npm test\n* npm run lint";
const NUMBERED_WHY_REPAIRED =
  "Conclusion: done\nWhy:\n- first\n- second\nBlockers: none\nChecks: npm test; npm run lint";
const WRAPPED_WHY =
  "Conclusion: done\nWhy: first line\n  second line\nBlockers: none\nChecks: npm test\n* npm run lint";
const WRAPPED_WHY_REPAIRED =
  "Conclusion: done\nWhy: first line second line\nBlockers: none\nChecks: npm test; npm run lint";
// The issue #2015 shape: every label but Blockers is present, and a prose lead with a dash list
// follows Why. The parser folds that section into the Why value.
const ABSENT_BLOCKERS = [
  "Conclusion: the setup works.",
  "",
  "Why: The profile holds the right values. The check confirms it.",
  "",
  "Blocker-free verification detail (setup):",
  "- positive (key auth): loaded; reached the host.",
  "- no-ssh control (no key): refused; logged.",
  "- negative control (bad key): refused; logged.",
  "",
  "Checks: node --test passed",
  "Notes: none",
  "Deferred: none.",
].join("\n");
// The canonical restatement keeps every word but puts the folded section under Checks.
const ABSENT_BLOCKERS_REPAIRED = [
  "Conclusion: the setup works.",
  "Why: The profile holds the right values. The check confirms it.",
  "Blockers: none",
  "Checks: node --test passed; Blocker-free verification detail (setup): positive (key auth): loaded; reached the host.; no-ssh control (no key): refused; logged.; negative control (bad key): refused; logged.",
  "Notes: none",
  "Deferred: none.",
].join("\n");

// The issue #2069 shape 3: Conclusion and Why come after the other four labels, in bold, so the
// block starts at the last Conclusion line and parses to null without Blockers.
const CONCLUSION_LAST = [
  "The run is verified.",
  "",
  "Blockers: none.",
  "Checks: npm test",
  "Notes: none",
  "Deferred: none",
  "",
  "**Conclusion:** the tests pass.",
  "",
  "**Why:** npm test exited 0.",
].join("\n");
// The canonical restatement keeps every value and puts Conclusion and Why first.
const CONCLUSION_LAST_REPAIRED = [
  "Conclusion: the tests pass.",
  "Why: npm test exited 0.",
  "Blockers: none.",
  "Checks: npm test",
  "Notes: none",
  "Deferred: none",
].join("\n");
// The same restatement with a changed check, which no reorder may accept.
const CONCLUSION_LAST_CHANGED = [
  "Conclusion: the tests pass.",
  "Why: npm test exited 0.",
  "Blockers: none.",
  "Checks: npm test failed",
  "Notes: none",
  "Deferred: none",
].join("\n");
// An explicitly empty Checks line above the block is no evidence, so a repair may not fill it.
const CONCLUSION_LAST_EMPTY_CHECKS = [
  "The run is verified.",
  "",
  "Blockers: none.",
  "Checks:",
  "Notes: none",
  "Deferred: none",
  "",
  "**Conclusion:** the tests pass.",
  "",
  "**Why:** npm test exited 0.",
].join("\n");

// A reviewer repair that moves the words `to run` from Deferred to Checks, so the failed check
// reads `failed to run`. The original Why is an explicit empty line with indented prose under it.
const REVIEWER_MOVED = [
  "Conclusion: done",
  "Why:",
  "  The suite failed.",
  "Blockers: none",
  "Checks: npm test failed",
  "Deferred: to run",
  "Verdict: accept",
].join("\n");
const REVIEWER_MOVED_REPAIRED = [
  "Conclusion: done",
  "Why: The suite failed.",
  "Blockers: none",
  "Checks: npm test failed to run",
  "Deferred:",
  "Verdict: accept",
].join("\n");
// A worker repair that swaps which suite passed while keeping every word.
const SWAPPED_WHY = [
  "Conclusion: done",
  "Why: suite one passed. suite two failed.",
  "Checks: none",
].join("\n");
const SWAPPED_WHY_REPAIRED = [
  "Conclusion: done",
  "Why: suite one failed. suite two passed.",
  "Blockers: none",
  "Checks: none",
].join("\n");
// An explicit empty Blockers line is not an absent Blockers line.
const EMPTY_BLOCKERS = "Conclusion: done\nWhy: tests pass\nBlockers:\nChecks: npm test";
const EMPTY_BLOCKERS_REPAIRED =
  "Conclusion: done\nWhy: tests pass\nBlockers: none\nChecks: npm test";
// A dash carries no word, but the parser reads it as the label value.
const BLOCKERS_DASH_REPAIRED = "Conclusion: done\nWhy: tests pass\nBlockers: -\nChecks: npm test";
// A reviewer repair joins a wrapped Why and keeps a dash Notes value unchanged. The star list
// under Checks makes the original block null, so the repair turn runs.
const DASH_NOTES = [
  "Conclusion: done",
  "Why: first line",
  "  second line",
  "Blockers: none",
  "Checks: npm test failed",
  "* npm run lint",
  "Notes: -",
  "Verdict: accept",
].join("\n");
const DASH_NOTES_REPAIRED = [
  "Conclusion: done",
  "Why: first line second line",
  "Blockers: none",
  "Checks: npm test failed; npm run lint",
  "Notes: -",
  "Verdict: accept",
].join("\n");
// The same repair, with the dash written as a dash list item. The parser folds the item into the
// Notes value.
const LISTED_DASH_NOTES = [
  "Conclusion: done",
  "Why: first line",
  "  second line",
  "Blockers: none",
  "Checks: npm test failed",
  "* npm run lint",
  "Notes:",
  "- -",
  "Verdict: accept",
].join("\n");
const LISTED_DASH_NOTES_REPAIRED = [
  "Conclusion: done",
  "Why: first line second line",
  "Blockers: none",
  "Checks: npm test failed; npm run lint",
  "Notes:",
  "- -",
  "Verdict: accept",
].join("\n");
// A repeated Checks label makes the fold fall back to raw lines, so the parser returns no
// per-label values for the original block. The repair removes the duplicate and keeps the dash.
const FALLBACK_DASH_NOTES = [
  "Conclusion: done",
  "Why: tests pass",
  "Blockers: none",
  "Checks:",
  "- npm test passed",
  "Checks: npm test passed",
  "Notes:",
  "- -",
  "Verdict: accept",
].join("\n");
const FALLBACK_DASH_NOTES_REPAIRED = [
  "Conclusion: done",
  "Why: tests pass",
  "Blockers: none",
  "Checks: npm test passed",
  "Notes:",
  "- -",
  "Verdict: accept",
].join("\n");

// One shared setup for the whole file. The in-memory Git answer reads top-level files at call
// time, so the reviewer mutation case still sees its write, and no test starts a Git process.
let repo;
beforeAll(async () => {
  repo = await createCleanRepoDir();
  gitDouble.answer = untrackedFilesGit;
});
beforeEach(async () => {
  await removePath(join(repo, "repair-leak.txt"));
});
afterAll(async () => {
  gitDouble.answer = null;
  await removePath(repo);
});

// Usefulness: verifies requirement "a child turn with report === null after a successful string
// response starts exactly one repair invocation in the same session" (issue #1615). Without the
// repair the report stays null and the parent receives the whole response as raw.
test("a null report starts one repair turn in the same session", async () => {
  const agent = scripted([INVALID, REPAIRED]);
  const events = [];
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
    stepsUsed: 3,
    onEvent: (event) => events.push(event),
  });

  expect(agent.recorded).toHaveLength(2);
  expect(agent.recorded[1].sessionId).toBe(agent.recorded[0].sessionId);
  expect(agent.recorded[1].prompt).toContain("Restate only the closing block");
  expect(result.status).toBe("ok");
  expect(result.response).toBe(REPAIRED);
  expect(result.report).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: "npm test",
    notes: "none",
    deferred: "none",
  });
  expect(result.reportMissingLabels).toBeUndefined();
  expect(result.reportRepairOutcome).toBeUndefined();

  const invocations = events.filter((event) => event.type === "invocation");
  expect(invocations).toHaveLength(2);
  expect(invocations.map((event) => event.stepsUsed)).toEqual([3, 3]);
});

// Usefulness: verifies requirement "one repair at most" (issue #1615). A repair that still parses
// to null leaves the original response in raw and starts no third invocation.
test("a repair that still parses to null leaves the original response", async () => {
  const agent = scripted([INVALID, "Conclusion: done\nWhy: tests pass"]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.status).toBe("ok");
  expect(result.response).toBe(INVALID);
  expect(result.report).toBeNull();
  expect(result.reportMissingLabels).toEqual(["Blockers"]);
  expect(result.reportRepairOutcome).toBe("null");
});

// Usefulness: verifies requirement "reviewer mutation detection still applies; a repair that writes
// in a reviewer turn is detected" (issue #1615). The repair runs in its own mutation check, so a
// write after the first turn cannot pass as formatting.
test("a reviewer repair that writes is a fatal mutation", async () => {
  const agent = scripted([
    INVALID,
    async () => {
      await writeFile(join(repo, "repair-leak.txt"), "leak\n");
      return REPAIRED_REVIEW;
    },
  ]);

  await expect(
    runChild({
      agents: { fake: agent },
      role: { kind: "fake", sessionId: null },
      roleName: "reviewer",
      prompt: "review",
      cwd: repo,
    }),
  ).rejects.toThrow(MutationError);
  expect(agent.recorded).toHaveLength(2);
});

// Usefulness: verifies requirement "a failed repair leaves the result not accepted, with the
// original response in raw" (issue #1615). The handled failure does not clear the session or start
// a rerun as a first turn.
test("a failed repair keeps the original response and the session", async () => {
  const agent = scripted([
    INVALID,
    () => {
      throw new Error("repair failed");
    },
  ]);
  const role = { kind: "fake", sessionId: null };
  const result = await runChild({
    agents: { fake: agent },
    role,
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(INVALID);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("failed");
  expect(role.sessionId).toBe(agent.recorded[0].sessionId);
});

// Usefulness: verifies requirement "a cancel during or before the repair ends the turn as a cancel"
// (issue #1615). A non-fatal repair failure must not swallow a cancel that landed with it.
test("a cancel during a failed repair ends the turn as canceled", async () => {
  const controller = new AbortController();
  const agent = scripted([
    INVALID,
    () => {
      controller.abort();
      throw new Error("repair failed");
    },
  ]);

  await expect(
    runChild({
      agents: { fake: agent },
      role: { kind: "fake", sessionId: null },
      roleName: "worker",
      prompt: "go",
      cwd: repo,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
});

// Usefulness: verifies requirement "a lost session leaves the result not accepted, with the
// original response in raw" (issue #1615). A repair that reports a missing session must not be
// rerun as a first turn, because a new conversation cannot restate the original report.
test("a repair on a lost session does not rerun as a first turn", async () => {
  const agent = scripted([
    INVALID,
    () => {
      throw Object.assign(new Error("No conversation found"), { sessionMissing: true });
    },
  ]);
  const role = { kind: "fake", sessionId: null };
  const result = await runChild({
    agents: { fake: agent },
    role,
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(INVALID);
  expect(result.report).toBeNull();
  expect(role.sessionId).toBe(agent.recorded[0].sessionId);
});

// Usefulness: verifies requirement "a replacement conversation cannot restate the original report"
// (issue #1615). The repair is rejected and the replacement mark stays, so the next turn delivers
// the role preamble or task to the new conversation.
test("a repair that replaces the conversation is rejected and keeps the mark", async () => {
  const agent = scripted([
    INVALID,
    (state) => {
      state.sessionId = "replacement-session";
      state.conversationReplaced = true;
      return REPAIRED;
    },
  ]);
  const role = { kind: "fake", sessionId: null };
  const result = await runChild({
    agents: { fake: agent },
    role,
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(INVALID);
  expect(result.report).toBeNull();
  expect(role.sessionId).toBe("replacement-session");
  expect(role.conversationReplaced).toBe(true);
});

// Usefulness: verifies requirement "the repair output is untrusted; it must never make a turn
// accepted that the original response did not accept" (issue #1615). An original reject cannot
// become an accept through the repaired block.
test("a repair cannot promote an original reject to an accept", async () => {
  const agent = scripted([REJECTED, REPAIRED_REVIEW]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(REJECTED);
  expect(result.report).toBeNull();
  expect(acceptanceFailure(result.response, result.report)).toBe("verdict");
});

// Usefulness: verifies requirement "the repair must never invent a verdict that the original
// response did not state" (issue #1615). A missing verdict stays not accepted.
test("a repair cannot invent a missing verdict", async () => {
  const agent = scripted([UNVERDICTED, REPAIRED_REVIEW]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(UNVERDICTED);
  expect(result.report).toBeNull();
  expect(acceptanceFailure(result.response, result.report)).toBe("verdict");
});

// Usefulness: verifies requirement "a repair must never make a turn accepted that the original
// response did not accept" (issue #1615). A repaired Checks line cannot supply the acceptance input
// that the original response left out.
test("a repair cannot add the Checks line that an accept needs", async () => {
  const agent = scripted([ACCEPT_NO_CHECKS, REPAIRED_REVIEW]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(ACCEPT_NO_CHECKS);
  expect(result.report).toBeNull();
  expect(acceptanceFailure(result.response, result.report)).toBe("checks");
});

// Usefulness: verifies requirement "an accept after repair needs the original response to hold a
// non-empty value for every required label" (issue #1615). An empty Why cannot become `none` and an
// accept.
test("a repair cannot make an accept from an empty required label", async () => {
  const agent = scripted([EMPTY_REQUIRED, EMPTY_REQUIRED_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(EMPTY_REQUIRED);
  expect(result.report).toBeNull();
  expect(acceptanceFailure(result.response, result.report)).toBe("checks");
});

// Usefulness: verifies requirement "an accept after repair needs the original response to hold a
// non-empty Checks value" (issue #1615). An empty Checks cannot become `none` and an accept.
test("a repair cannot make an accept from an empty Checks label", async () => {
  const agent = scripted([EMPTY_CHECKS, EMPTY_CHECKS_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(EMPTY_CHECKS);
  expect(result.report).toBeNull();
  expect(acceptanceFailure(result.response, result.report)).toBe("checks");
});

// Usefulness: verifies requirement "the repair keeps the findings and checks of the original
// response" (issue #1615). A repaired block that changes a field is rejected.
test("a repair cannot change the original findings", async () => {
  const agent = scripted([UNVERDICTED, CHANGED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(UNVERDICTED);
  expect(result.report).toBeNull();
});

// Usefulness: verifies requirement "every finding of the original must survive into the repaired
// report" (issue #1615). A star-list finding that the repair drops is content loss.
test("a repair cannot drop a star-list finding", async () => {
  const agent = scripted([STAR_WHY, STAR_WHY_DROPPED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(STAR_WHY);
  expect(result.report).toBeNull();
});

// Usefulness: verifies requirement "every check of the original must survive into the repaired
// report" (issue #1615). A failed check that the repair drops is content loss.
test("a repair cannot drop a failed check", async () => {
  const agent = scripted([STAR_CHECKS, STAR_CHECKS_DROPPED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(STAR_CHECKS);
  expect(result.report).toBeNull();
});

// Usefulness: verifies requirement "a faithful restatement is not rejected when the repair
// converts a list form" (issue #1615). A `*` list becomes a `-` list with the same content.
test("a repair accepts a star-list to dash-list conversion", async () => {
  const agent = scripted([STAR_WHY, STAR_WHY_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(STAR_WHY_REPAIRED);
  expect(result.report).toMatchObject({ why: "first; second" });
});

// Usefulness: verifies requirement "a faithful restatement is not rejected when the repair
// converts a numbered list" (issue #1615). The same items in a dash list keep the content.
test("a repair accepts a numbered-list conversion", async () => {
  const agent = scripted([NUMBERED_WHY, NUMBERED_WHY_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(NUMBERED_WHY_REPAIRED);
  expect(result.report).toMatchObject({ why: "first; second" });
});

// Usefulness: verifies requirement "a faithful restatement is not rejected when the repair joins
// wrapped lines" (issue #1615). The joined line keeps every word of the original.
test("a repair accepts joined wrapped lines", async () => {
  const agent = scripted([WRAPPED_WHY, WRAPPED_WHY_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(WRAPPED_WHY_REPAIRED);
  expect(result.report).toMatchObject({ why: "first line second line" });
});

// Usefulness: verifies requirement "a worker response in the issue shape names why the repair did
// not recover it, with no response text" (issue #2015). The canonical restatement moves the folded
// section from Why to Checks, which the exact match refuses.
test("an issue #2015 shape names the mismatched repair outcome", async () => {
  const agent = scripted([ABSENT_BLOCKERS, ABSENT_BLOCKERS_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.status).toBe("ok");
  expect(result.response).toBe(ABSENT_BLOCKERS);
  expect(result.report).toBeNull();
  expect(result.reportMissingLabels).toEqual(["Blockers"]);
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "a repair of the issue #2069 shape 3 returns the same values in
// order, so it matches" (issue #2069). The four labels above the last Conclusion line are the
// original's values, so reordering them into the canonical form is no content change.
test("a repair accepts the issue #2069 shape 3 with reordered labels", async () => {
  const agent = scripted([CONCLUSION_LAST, CONCLUSION_LAST_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.status).toBe("ok");
  expect(result.response).toBe(CONCLUSION_LAST_REPAIRED);
  expect(result.report).toEqual({
    conclusion: "the tests pass.",
    why: "npm test exited 0.",
    blockers: "none.",
    checks: "npm test",
    notes: "none",
    deferred: "none",
  });
  expect(result.reportRepairOutcome).toBeUndefined();
});

// Usefulness: verifies requirement "keep every existing refusal of the match check for a real value
// change" (issue #2069). A label above the block that the repair changes still refuses the repair.
test("a repair of the issue #2069 shape 3 refuses a changed label value", async () => {
  const agent = scripted([CONCLUSION_LAST, CONCLUSION_LAST_CHANGED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(CONCLUSION_LAST);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "an explicitly empty label is not an absent label" for the issue
// #2069 shape (issue #2015 review). A repair of the reordered labels may not fill an empty Checks
// line that the response wrote above the block.
test("a repair of the issue #2069 shape 3 cannot fill an empty Checks line", async () => {
  const agent = scripted([CONCLUSION_LAST_EMPTY_CHECKS, CONCLUSION_LAST_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(CONCLUSION_LAST_EMPTY_CHECKS);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "a repair never accepts a restatement that moves content between
// labels" (issue #2015 review). The move makes a failed reviewer check read as a check not yet run,
// and the original empty Why line must not turn that into an accept.
test("a reviewer repair that moves a word into Checks is refused", async () => {
  const agent = scripted([REVIEWER_MOVED, REVIEWER_MOVED_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(REVIEWER_MOVED);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "a repair never accepts a restatement that moves content between
// labels" (issue #2015 review). The swap reverses which suite passed while keeping each word.
test("a worker repair that swaps which suite passed is refused", async () => {
  const agent = scripted([SWAPPED_WHY, SWAPPED_WHY_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(SWAPPED_WHY);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "an explicit empty label is not an absent label" (issue #2015
// review). The repair may not fill an empty Blockers line with none.
test("a repair cannot fill an explicitly empty required label", async () => {
  const agent = scripted([EMPTY_BLOCKERS, EMPTY_BLOCKERS_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(EMPTY_BLOCKERS);
  expect(result.report).toBeNull();
  expect(result.reportMissingLabels).toEqual(["Blockers"]);
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "a repair keeps every label value that the original holds, a dash
// value included" (issue #2015 review). The wrapped Why joins and the Notes dash stays unchanged.
test("a repair keeps a dash label value that the original holds", async () => {
  const agent = scripted([DASH_NOTES, DASH_NOTES_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(DASH_NOTES_REPAIRED);
  expect(result.report).toMatchObject({
    why: "first line second line",
    notes: "-",
  });
  expect(result.reportRepairOutcome).toBeUndefined();
});

// Usefulness: verifies requirement "a label whose parsed value the original holds keeps the same
// comparison, a listed dash included" (issue #2015 review). The parser folds the dash item, and the
// repair keeps it unchanged while joining the wrapped Why.
test("a repair keeps a listed dash label value that the original holds", async () => {
  const agent = scripted([LISTED_DASH_NOTES, LISTED_DASH_NOTES_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(LISTED_DASH_NOTES_REPAIRED);
  expect(result.report).toMatchObject({
    why: "first line second line",
    notes: "-",
  });
  expect(result.reportRepairOutcome).toBeUndefined();
});

// Usefulness: verifies requirement "a fallback original keeps main's result for a faithful repair"
// (issue #2015 review). The repeated Checks label makes the fold fall back to raw lines, so the new
// added-value check does not apply and the Notes dash stays accepted.
test("a fallback original keeps the inherited result for a listed dash", async () => {
  const agent = scripted([FALLBACK_DASH_NOTES, FALLBACK_DASH_NOTES_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(FALLBACK_DASH_NOTES_REPAIRED);
  expect(result.report).toMatchObject({ notes: "-" });
  expect(result.reportRepairOutcome).toBeUndefined();
});

// Usefulness: verifies requirement "a repair cannot fill an explicitly empty label with a value the
// original did not hold" (issue #2015 review). A lone dash has no word but the parser reads it as a
// value, so the matcher must refuse it.
test("a repair cannot fill an explicitly empty label with a dash", async () => {
  const agent = scripted([EMPTY_BLOCKERS, BLOCKERS_DASH_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(EMPTY_BLOCKERS);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "a label that the original omits may gain only none" (issue
// #2015 review). A lone dash is a value the original did not hold.
test("a repair cannot gain a dash for an absent label", async () => {
  const agent = scripted([INVALID, BLOCKERS_DASH_REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(2);
  expect(result.response).toBe(INVALID);
  expect(result.report).toBeNull();
  expect(result.reportRepairOutcome).toBe("mismatched");
});

// Usefulness: verifies requirement "the policy for a parsed report without a reviewer Checks line or
// Verdict line is stated and implemented" (issue #1615). Only a null report triggers a repair, so
// the existing fail-closed acceptance policy stays in force with no extra invocation.
test.each([
  {
    name: "Checks",
    response: "Conclusion: done\nWhy: tests pass\nBlockers: none\nVerdict: accept",
    expected: "checks",
  },
  {
    name: "Verdict",
    response: REPAIRED,
    expected: "verdict",
  },
])(
  "a parsed report without a reviewer $name line is not repaired",
  async ({ response, expected }) => {
    const agent = scripted([response]);
    const result = await runChild({
      agents: { fake: agent },
      role: { kind: "fake", sessionId: null },
      roleName: "reviewer",
      prompt: "review",
      cwd: repo,
    });

    expect(agent.recorded).toHaveLength(1);
    expect(result.report).not.toBeNull();
    expect(acceptanceFailure(result.response, result.report)).toBe(expected);
  },
);

// Usefulness: verifies a parsed worker report that points above the block names its label on the
// result (issue #1907).
test("a worker report that points above the block carries its label", async () => {
  const pointer = [
    "The runner environment holds no `SUBFAILED` line.",
    "",
    "Conclusion: the required check failed",
    "Why: the inference above, from the runner env",
    "Blockers: none",
  ].join("\n");
  const agent = scripted([pointer]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Why"]);
});

// The turn A shape of issue #1918: Checks points at the mutation list in Why of the same report.
const SAME_REPORT_POINTER = [
  "Conclusion: the fix is complete.",
  "Why:",
  "- **Mutations:** every mutant failed the guard.",
  "  - mutant 1: two failures",
  "  - mutant 2: one failure",
  "Blockers: none",
  "Checks:",
  "- Mutation runs: all fail as listed above.",
].join("\n");

// Usefulness: verifies the turn A shape with no text outside the block carries no field, because
// nothing outside the block exists (issue #1918).
test("a report whose pointer names an earlier label carries no field with no outside text", async () => {
  const agent = scripted([SAME_REPORT_POINTER]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result.report.checks).toBe("Mutation runs: all fail as listed above.");
  expect(result).not.toHaveProperty("reportOutsideBlockLabels");
});

// Usefulness: verifies the turn A shape with prose before the block keeps the origin/main field,
// because the response holds text outside the block (issue #1918).
test("a report whose pointer names an earlier label keeps the field with outside text", async () => {
  const response = ["The mutation runs are complete.", "", SAME_REPORT_POINTER].join("\n");
  const agent = scripted([response]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Checks"]);
});

// The turn B shape of issue #1918: Notes points at the description in Why of the same report.
const SAME_REPORT_NOTES = [
  "Conclusion: fixed.",
  "Why: the six deliberate concurrent copies ran in separate work trees.",
  "Blockers: none",
  "Checks: npm test",
  'Notes: "<quoted phrase>" meant the six deliberate concurrent copies described above.',
].join("\n");

// Usefulness: verifies the turn B shape with no text outside the block carries no field, because
// nothing outside the block exists (issue #1918).
test("a report whose Notes names an earlier label carries no field with no outside text", async () => {
  const result = await runChild({
    agents: { fake: scripted([SAME_REPORT_NOTES]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result).not.toHaveProperty("reportOutsideBlockLabels");
});

// Usefulness: verifies the turn B shape with prose before the block keeps the origin/main field,
// because the response holds text outside the block (issue #1918).
test("a report whose Notes names an earlier label keeps the field with outside text", async () => {
  const response = ["The copies are listed in the record.", "", SAME_REPORT_NOTES].join("\n");
  const result = await runChild({
    agents: { fake: scripted([response]) },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Notes"]);
});

// Usefulness: verifies a parsed worker report that points nowhere carries no field, so the parent
// reads an ordinary report (issue #1907).
test("a worker report that points nowhere carries no outside-block field", async () => {
  const agent = scripted(["Conclusion: done\nWhy: tests pass\nBlockers: none"]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result).not.toHaveProperty("reportOutsideBlockLabels");
});

// Usefulness: verifies the result names a reviewer report label that points above the block
// (issue #1910).
test("a reviewer report that points above the block carries its label", async () => {
  const pointer = [
    "The diff holds no write.",
    "",
    "Conclusion: the fix passes",
    "Why: the check above",
    "Blockers: none",
  ].join("\n");
  const agent = scripted([pointer]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Why"]);
});

// Usefulness: verifies a reviewer pointer after quoted text carries its label, because the
// reviewer prompt bars every reference to text outside the block (issue #1910).
test("a reviewer report with quoted text carries its label", async () => {
  const pointer = [
    "> The diff holds no write.",
    "",
    "Conclusion: the fix passes",
    "Why: the quoted check above",
    "Blockers: none",
  ].join("\n");
  const agent = scripted([pointer]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Why"]);
});

// Usefulness: verifies a reviewer pointer after two paragraphs carries its label, because the
// reviewer prompt has no exception (issue #1910).
test("a reviewer report with two paragraphs carries its label", async () => {
  const pointer = [
    "The diff holds no write.",
    "",
    "The check listing shows every job green.",
    "",
    "Conclusion: the fix passes",
    "Why: the check above",
    "Blockers: none",
  ].join("\n");
  const agent = scripted([pointer]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result.reportOutsideBlockLabels).toEqual(["Why"]);
});

// Usefulness: verifies a worker report keeps the quoted-text exception and carries no field
// (issue #1910).
test("a worker report keeps the quoted-text exception", async () => {
  const pointer = [
    "> The diff holds no write.",
    "",
    "Conclusion: the fix passes",
    "Why: the quoted check above",
    "Blockers: none",
  ].join("\n");
  const agent = scripted([pointer]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    cwd: repo,
  });

  expect(agent.recorded).toHaveLength(1);
  expect(result.report).not.toBeNull();
  expect(result).not.toHaveProperty("reportOutsideBlockLabels");
});

// A task that holds report label lines, so a plain copy parses as a report.
const COPIED_TASK = [
  "Conclusion: TASK-LABEL-CONCLUSION-1914",
  "Why: TASK-LABEL-WHY-1914",
  "Blockers: none",
  "Checks: TASK-LABEL-CHECKS-1914",
].join("\n");

// Usefulness: verifies a first worker turn that copies the task label lines names each copied
// label on its result (issue #1914).
test("a first worker turn names each label copied from the init task", async () => {
  const agent = scripted([COPIED_TASK]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    task: COPIED_TASK,
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result.reportCopiedTaskLabels).toEqual(["Conclusion", "Why", "Checks"]);
});

// Usefulness: verifies a later turn of the same conversation still names the copied labels, and
// its prompt carries no init task (issue #1914).
test("a later turn of the same conversation names the copied labels", async () => {
  const agent = scripted([REPAIRED, COPIED_TASK]);
  const role = { kind: "fake", sessionId: null };
  const options = {
    agents: { fake: agent },
    role,
    roleName: "worker",
    prompt: "go",
    task: COPIED_TASK,
    cwd: repo,
  };
  const first = await runChild(options);
  const later = await runChild(options);

  expect(agent.recorded).toHaveLength(2);
  expect(agent.recorded[1].sessionId).toBe(agent.recorded[0].sessionId);
  expect(agent.recorded[1].prompt).not.toContain("Init task:");
  expect(first.report).not.toBeNull();
  expect(later.report).not.toBeNull();
  expect(first).not.toHaveProperty("reportCopiedTaskLabels");
  expect(later.reportCopiedTaskLabels).toEqual(["Conclusion", "Why", "Checks"]);
});

// Usefulness: verifies a worker report whose values differ from the task carries no field, so the
// parent reads an ordinary report (issue #1914).
test("a worker report whose values differ from the task carries no field", async () => {
  const agent = scripted([REPAIRED]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "worker",
    prompt: "go",
    task: COPIED_TASK,
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result).not.toHaveProperty("reportCopiedTaskLabels");
});

// Usefulness: verifies a reviewer Verdict line equal to a task Verdict line carries no field,
// because accept is a normal reviewer answer (issue #1914).
test("a reviewer Verdict line equal to the task verdict carries no field", async () => {
  const task = "Conclusion: TASK-CONCLUSION-1914\nWhy: TASK-WHY-1914\nVerdict: accept";
  const reply = [
    "Conclusion: the fix passes",
    "Why: the new test passes",
    "Blockers: none",
    "Verdict: accept",
  ].join("\n");
  const agent = scripted([reply]);
  const result = await runChild({
    agents: { fake: agent },
    role: { kind: "fake", sessionId: null },
    roleName: "reviewer",
    prompt: "review",
    task,
    cwd: repo,
  });

  expect(result.report).not.toBeNull();
  expect(result).not.toHaveProperty("reportCopiedTaskLabels");
});
