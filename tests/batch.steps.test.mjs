import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { countSteps, readStepsUsed } from "../src/batch/steps.mjs";
import { removePath } from "./fs-helpers.mjs";

const transcript = (events) => JSON.stringify({ events, exitCode: 1, error: null });

const result = (stepsUsed) => ({ type: "result", role: "worker", stepsUsed });
const action = (name) => ({ type: "action", action: { action: name }, stepsUsed: 0 });

// Usefulness: one attempt spends its highest charged step count.
test("one segment counts its highest result", () => {
  expect(countSteps(transcript([action("run_worker"), result(1), result(3)]))).toEqual({
    ok: true,
    steps: 3,
  });
});

// Usefulness: a trailing dispatched turn with no result is charged, because the runtime charged it.
test("a trailing action with no result counts one more", () => {
  expect(countSteps(transcript([action("run_worker"), result(2), action("run_reviewer")]))).toEqual(
    {
      ok: true,
      steps: 3,
    },
  );
});

// Usefulness: a continuation splits the budget across attempts, and the sum is the loop's spend.
test("segments split at each continued event are summed", () => {
  const text = transcript([
    action("run_worker"),
    result(3),
    { type: "continued", exitCode: 130 },
    action("run_worker"),
    result(2),
  ]);
  expect(countSteps(text)).toEqual({ ok: true, steps: 5 });
});

// Usefulness: a stale checkpoint cannot undercount a transcript.
test("the larger of the checkpoint and the transcript wins", () => {
  expect(countSteps(transcript([result(2)]), { checkpointSteps: 5 })).toEqual({
    ok: true,
    steps: 5,
  });
});

// Usefulness: an unreadable transcript stops the loop as needs-owner instead of guessing a budget.
test("an unreadable transcript cannot establish a count", () => {
  expect(countSteps("not json").ok).toBe(false);
  expect(countSteps(JSON.stringify({ events: [result("many")] })).ok).toBe(false);
  expect(countSteps(JSON.stringify({ events: "none" })).ok).toBe(false);
});

// Usefulness: a missing transcript with no attempt is a proven zero, not a guess.
test("a missing transcript reads zero for a loop with no attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-steps-"));
  try {
    const missing = join(root, "missing.json");
    expect(await readStepsUsed(missing, { checkpointSteps: 0, attempts: 0 })).toEqual({
      ok: true,
      steps: 0,
    });
    expect((await readStepsUsed(missing, { attempts: 1 })).ok).toBe(false);
  } finally {
    await removePath(root);
  }
});

// Usefulness: a transcript file is read whole.
test("a transcript file is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-steps-"));
  try {
    const file = join(root, "run.json");
    await writeFile(file, transcript([result(4)]));
    expect(await readStepsUsed(file, { attempts: 1 })).toEqual({ ok: true, steps: 4 });
  } finally {
    await removePath(root);
  }
});
