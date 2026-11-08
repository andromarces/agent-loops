import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  ABANDON_REASON,
  answerDecision,
  createDecision,
  newDecisionId,
  readAnswer,
  readDecision,
} from "../../src/batch/decisions.mjs";
import {
  acquireClaim,
  batchPaths,
  createBatchStore,
  readLoop,
  updateLoop,
} from "../../src/batch/store.mjs";
import { removePath } from "../fs-helpers.mjs";

const REPO = "/work/repo";
const REPO_KEY = "abcabcabcabc";
const BATCH = "b1";

function manifest(id = BATCH, issues = [1, 2]) {
  return {
    id,
    repo: REPO,
    repoKey: REPO_KEY,
    createdAt: "2026-11-09T00:00:00.000Z",
    base: "main",
    workTreeRoot: "/work/root",
    issues,
    status: "running",
    settings: { loops: 1, maxSteps: 10 },
  };
}

function loop(issue, decision = null) {
  return {
    issue,
    status: decision === null ? "queued" : "needs-owner",
    skipReason: null,
    reason: decision === null ? null : "a reason",
    attempts: decision === null ? 0 : 1,
    branch: `batch/${BATCH}/${issue}`,
    workTree: null,
    transcript: `/work/transcript-${issue}.json`,
    log: null,
    pid: null,
    startTime: null,
    stepsUsed: decision === null ? 0 : 2,
    remainingSteps: decision === null ? 10 : 8,
    pr: null,
    cleanup: null,
    decision,
    decisionAnswer: null,
    blockingIssues: [],
  };
}

async function storeFor() {
  const root = await mkdtemp(join(tmpdir(), "batch-decisions-"));
  const first = newDecisionId(BATCH, 1, 1, "a reason");
  const second = newDecisionId(BATCH, 2, 1, "another reason");
  await createBatchStore(root, manifest(), [loop(1, first), loop(2, second)]);
  await createDecision({
    runsRoot: root,
    batchId: BATCH,
    id: first,
    issue: 1,
    attempt: 1,
    reason: "a reason",
    evidence: "the remote state",
  });
  await createDecision({
    runsRoot: root,
    batchId: BATCH,
    id: second,
    issue: 2,
    attempt: 1,
    reason: "another reason",
    evidence: "the local state",
  });
  return { root, first, second };
}

// Usefulness: the decision id is stable for one state and unique across reasons and attempts.
test("a decision id names the batch, issue, attempt, and reason", () => {
  expect(newDecisionId("b1", 3, 2, "x")).toBe(newDecisionId("b1", 3, 2, "x"));
  expect(newDecisionId("b1", 3, 2, "x")).not.toBe(newDecisionId("b1", 3, 2, "y"));
  expect(newDecisionId("b1", 3, 2, "x")).not.toBe(newDecisionId("b1", 3, 3, "x"));
});

// Usefulness: a repeated create of one decision writes nothing and keeps the first record.
test("a decision create with an existing id writes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-decisions-"));
  try {
    const id = newDecisionId(BATCH, 1, 1, "a reason");
    const params = {
      runsRoot: root,
      batchId: BATCH,
      id,
      issue: 1,
      attempt: 1,
      reason: "a reason",
      evidence: null,
    };
    await createDecision(params);
    const file = batchPaths(root).decision(BATCH, id);
    const before = await stat(file, { bigint: true });
    const again = await createDecision(params);
    const after = await stat(file, { bigint: true });
    expect(again.created).toBe(false);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a decision lists at least two options and one recommendation.
test("a decision holds two options and one recommendation", async () => {
  const { root, first } = await storeFor();
  try {
    const read = await readDecision(root, BATCH, first);
    expect(read.ok).toBe(true);
    expect(read.decision.options.length).toBeGreaterThanOrEqual(2);
    expect(read.decision.options.map((option) => option.key)).toContain(read.decision.recommended);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a partial decision file fails closed and is reported, never guessed.
test("a malformed decision file is refused", async () => {
  const { root, first } = await storeFor();
  try {
    await writeFile(batchPaths(root).decision(BATCH, first), "{");
    const read = await readDecision(root, BATCH, first);
    expect(read.ok).toBe(false);
  } finally {
    await removePath(root);
  }
});

// Usefulness: an unknown decision refuses an answer and writes no answer file.
test("an unknown decision is refused and writes nothing", async () => {
  const { root } = await storeFor();
  try {
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: "no-such-decision",
      option: "resume",
    });
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(true);
    await expect(readdir(batchPaths(root).answers(BATCH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: a decision of another batch is refused under the named batch.
test("a decision of another batch is refused", async () => {
  const { root, first } = await storeFor();
  try {
    await createBatchStore(root, manifest("b2", [1]), [loop(1)]);
    const result = await answerDecision({
      runsRoot: root,
      batchId: "b2",
      decisionId: first,
      option: "resume",
    });
    expect(result.ok).toBe(false);
    await expect(readdir(batchPaths(root).answers(BATCH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: an option that the decision does not list is refused with no write.
test("an unlisted option is refused", async () => {
  const { root, first } = await storeFor();
  try {
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "force-push",
    });
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(true);
    await expect(readdir(batchPaths(root).answers(BATCH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: two answers to one decision race safely, so exactly one wins.
test("two concurrent answers to one decision have one winner", async () => {
  const { root, first } = await storeFor();
  try {
    const params = { runsRoot: root, batchId: BATCH, decisionId: first, option: "resume" };
    const [a, b] = await Promise.all([answerDecision(params), answerDecision(params)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const answer = await readAnswer(root, BATCH, first);
    expect(answer.ok).toBe(true);
    expect(answer.answer.option).toBe("resume");
  } finally {
    await removePath(root);
  }
});

// Usefulness: a resume answer returns the loop to the queue with its remaining budget.
test("a resume answer queues the loop", async () => {
  const { root, first } = await storeFor();
  try {
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "resume",
    });
    expect(result.ok).toBe(true);
    const loopRead = await readLoop(root, BATCH, 1);
    expect(loopRead).toMatchObject({
      status: "queued",
      decisionAnswer: "resume",
      remainingSteps: 8,
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: an abandon answer ends the loop and releases its claim.
test("an abandon answer fails the loop and releases its claim", async () => {
  const { root, first } = await storeFor();
  try {
    await acquireClaim(root, REPO_KEY, 1, { batchId: BATCH, pid: process.pid });
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "abandon",
    });
    expect(result.ok).toBe(true);
    expect(await readLoop(root, BATCH, 1)).toMatchObject({
      status: "failed",
      reason: ABANDON_REASON,
    });
    await expect(stat(batchPaths(root).claim(REPO_KEY, 1))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: an answer to one decision leaves another pending decision untouched.
test("an answer does not resolve another pending decision", async () => {
  const { root, first, second } = await storeFor();
  try {
    await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "resume",
    });
    expect(await readLoop(root, BATCH, 2)).toMatchObject({
      status: "needs-owner",
      decision: second,
    });
    await expect(stat(batchPaths(root).answer(BATCH, second))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: an already answered decision is refused with no second write.
test("a second answer to one decision is refused", async () => {
  const { root, first } = await storeFor();
  try {
    await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "resume",
    });
    const second = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "abandon",
    });
    expect(second.ok).toBe(false);
    expect(second.usage).toBe(true);
    const read = await readAnswer(root, BATCH, first);
    expect(read.answer.option).toBe("resume");
  } finally {
    await removePath(root);
  }
});

// Usefulness: a malformed answer file fails closed and is never overwritten or guessed.
test("a malformed answer file is refused", async () => {
  const { root, first } = await storeFor();
  try {
    await mkdir(batchPaths(root).answers(BATCH), { recursive: true });
    await writeFile(batchPaths(root).answer(BATCH, first), "{");
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "resume",
    });
    expect(result.ok).toBe(false);
    expect(result.usage).not.toBe(true);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a loop that already moved on refuses the answer of its old decision.
test("a stale loop refuses the answer", async () => {
  const { root, first } = await storeFor();
  try {
    await updateLoop(root, BATCH, 1, (value) => ({
      ...value,
      decision: null,
      status: "succeeded",
    }));
    const result = await answerDecision({
      runsRoot: root,
      batchId: BATCH,
      decisionId: first,
      option: "resume",
    });
    expect(result.ok).toBe(false);
    expect(result.usage).toBe(true);
    await expect(readdir(batchPaths(root).answers(BATCH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await removePath(root);
  }
});
