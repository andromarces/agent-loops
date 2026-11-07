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
