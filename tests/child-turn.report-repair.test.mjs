import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { runChild } from "../src/child-turn.mjs";
import { acceptanceFailure } from "../src/lib/report.mjs";
import { MutationError } from "../src/lib/snapshot.mjs";
import { scripted } from "./agent-doubles.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";

// A response whose closing block has no Blockers label, so it parses to null.
const INVALID = "Conclusion: done\nWhy: tests pass";
const REPAIRED = [
  "Conclusion: done",
  "Why: tests pass",
  "Blockers: none",
  "Checks: npm test",
  "Notes: none",
  "Deferred: none",
].join("\n");
const REPAIRED_REVIEW = `${REPAIRED}\nVerdict: accept`;

let repo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
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
