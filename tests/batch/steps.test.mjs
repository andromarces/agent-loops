import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  readTranscript,
  stepsFromRead,
  stepsUsedFromData,
  transcriptExitFromData,
} from "../../src/batch/steps.mjs";
import { removePath } from "../fs-helpers.mjs";

const transcript = (events) => JSON.stringify({ events, exitCode: 1, error: null });
const parsed = (events) => JSON.parse(transcript(events));

const result = (stepsUsed) => ({ type: "result", role: "worker", stepsUsed });
const action = (name) => ({ type: "action", action: { action: name }, stepsUsed: 0 });

// Usefulness: one attempt spends its highest charged step count.
test("one segment counts its highest result", () => {
  expect(stepsUsedFromData(parsed([action("run_worker"), result(1), result(3)]))).toMatchObject({
    ok: true,
    steps: 3,
  });
});

// Usefulness: a trailing dispatched turn with no result is charged, because the runtime charged it.
test("a trailing action with no result counts one more", () => {
  expect(
    stepsUsedFromData(parsed([action("run_worker"), result(2), action("run_reviewer")])),
  ).toMatchObject({
    ok: true,
    steps: 3,
  });
});

// Usefulness: a continuation splits the budget across attempts, and the sum is the loop's spend.
test("segments split at each continued event are summed", () => {
  const data = parsed([
    action("run_worker"),
    result(3),
    { type: "continued", exitCode: 130 },
    action("run_worker"),
    result(2),
  ]);
  expect(stepsUsedFromData(data)).toMatchObject({ ok: true, steps: 5 });
});

// Usefulness: a previous attempt that charged a step for a trailing dispatch keeps that charge.
test("a trailing dispatch in an earlier segment is charged", () => {
  const data = parsed([
    action("run_worker"),
    result(9),
    action("run_reviewer"),
    { type: "continued", exitCode: 130 },
    action("run_worker"),
  ]);
  expect(stepsUsedFromData(data)).toMatchObject({ ok: true, steps: 11 });
});

// Usefulness: a stale checkpoint cannot undercount a transcript.
test("the larger of the checkpoint and the transcript wins", () => {
  expect(stepsUsedFromData(parsed([result(2)]), { checkpointSteps: 5 })).toMatchObject({
    ok: true,
    steps: 5,
  });
});

// Usefulness: an unreadable transcript stops the loop as needs-owner instead of guessing a budget.
test("an unreadable transcript cannot establish a count", async () => {
  expect((await readTranscript("run.json", async () => "not json")).ok).toBe(false);
  expect(stepsUsedFromData({ events: [result("many")] }).ok).toBe(false);
  expect(stepsUsedFromData({ events: "none" }).ok).toBe(false);
});

// Usefulness: a transcript that does not cover the latest attempt cannot prove its count.
test("a transcript with fewer segments than attempts is unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-steps-"));
  try {
    const file = join(root, "run.json");
    await writeFile(file, transcript([result(3)]));
    const read = stepsFromRead(await readTranscript(file), { attempts: 2 });
    expect(read.ok).toBe(false);
    expect(read.reason).toContain("attempt");
  } finally {
    await removePath(root);
  }
});

// Usefulness: a missing transcript with no attempt is a proven zero, not a guess.
test("a missing transcript reads zero for a loop with no attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-steps-"));
  try {
    const missing = join(root, "missing.json");
    const read = await readTranscript(missing);
    expect(stepsFromRead(read, { checkpointSteps: 0, attempts: 0 })).toMatchObject({
      ok: true,
      steps: 0,
    });
    expect(stepsFromRead(read, { attempts: 1 }).ok).toBe(false);
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
    expect(stepsFromRead(await readTranscript(file), { attempts: 1 })).toMatchObject({
      ok: true,
      steps: 4,
    });
  } finally {
    await removePath(root);
  }
});

// Usefulness: the default exit code of a pre-turn transcript write is not a finished run.
test("a transcript without a gate event does not prove its exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "batch-steps-"));
  try {
    const file = join(root, "run.json");
    await writeFile(file, JSON.stringify({ events: [result(1)], exitCode: 1, error: null }));
    expect(transcriptExitFromData((await readTranscript(file)).data)).toMatchObject({
      ok: true,
      exitCode: 1,
      proven: false,
    });
    await writeFile(
      file,
      JSON.stringify({ events: [result(1), { type: "gate" }], exitCode: 0, error: null }),
    );
    expect(transcriptExitFromData((await readTranscript(file)).data)).toMatchObject({
      ok: true,
      exitCode: 0,
      proven: true,
    });
  } finally {
    await removePath(root);
  }
});
