import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { buildLoopReport, missingLoopReport, readLoopReport } from "../../src/batch/report.mjs";
import { createTranscriptWriter } from "../../src/lib/transcript.mjs";
import { recordRunWarning, withRunWarnings } from "../../src/lib/run-warnings.mjs";
import { removePath } from "../fs-helpers.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removePath(dir);
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "batch-report-"));
  dirs.push(dir);
  return dir;
}

const SUMMARY = {
  changed: "the change",
  verified: "the checks",
  deferred: "nothing",
  notDone: "nothing",
  open: "none",
};

const finishEvent = (summary) => ({ type: "action", action: { action: "finish", summary } });
const continuedEvent = () => ({ type: "continued", earlier: { exitCode: 1, error: "old" } });

// Usefulness: a finished attempt reports its summary, and a five-key summary reads notes as null.
test("a finished loop report keeps the summary and reads a missing notes key as null", () => {
  const report = buildLoopReport(
    { events: [finishEvent(SUMMARY), { type: "gate" }], exitCode: 0, error: null },
    { attempts: 1 },
  );
  expect(report.transcriptRead).toEqual({ ok: true });
  expect(report.state).toBe("read");
  expect(report.summary).toEqual({ ...SUMMARY, notes: null });
  expect(report.error).toBeNull();
  expect(report.failedTurnTest).toBeNull();
  expect(report.warnings).toEqual([]);
  expect(report.warningsOverflow).toBe(0);
});

// Usefulness: a finish summary with notes carries that text into the report unchanged.
test("a finish summary with notes keeps the notes text", () => {
  const report = buildLoopReport(
    {
      events: [finishEvent({ ...SUMMARY, notes: "a later check" }), { type: "gate" }],
      exitCode: 4,
      error: null,
    },
    { attempts: 1 },
  );
  expect(report.summary.notes).toBe("a later check");
});

// Usefulness: a retried loop with a first finish and a second failure reports only the second attempt.
test("a first attempt that finished does not leak into a later failed attempt", () => {
  const report = buildLoopReport(
    {
      events: [
        finishEvent({ ...SUMMARY, changed: "first attempt" }),
        { type: "gate" },
        continuedEvent(),
        { type: "action", action: { action: "run_worker" } },
      ],
      exitCode: 1,
      error: "the second attempt failed",
      warnings: [],
    },
    { attempts: 2 },
  );
  expect(report.summary).toBeNull();
  expect(report.error).toBe("the second attempt failed");
  expect(report.warnings).toEqual([]);
  expect(JSON.stringify(report)).not.toContain("first attempt");
});

// Usefulness: a retried loop with a first failure and a second finish reports only the second summary.
test("a first failure does not leak into a later finished attempt", () => {
  const report = buildLoopReport(
    {
      events: [
        { type: "test-run", fatal: true, testRun: { command: "first failure" } },
        continuedEvent(),
        finishEvent({ ...SUMMARY, changed: "second attempt" }),
        { type: "gate" },
      ],
      exitCode: 0,
      error: null,
      warnings: [],
    },
    { attempts: 2 },
  );
  expect(report.summary.changed).toBe("second attempt");
  expect(report.error).toBeNull();
  expect(report.failedTurnTest).toBeNull();
  expect(JSON.stringify(report)).not.toContain("first failure");
});

// Usefulness: a fatal turn test event of the last attempt reaches the report as failedTurnTest.
test("a fatal turn test event reaches the report", () => {
  const report = buildLoopReport(
    {
      events: [
        { type: "test-run", fatal: true, testRun: { command: "pnpm test", status: "fail" } },
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.failedTurnTest).toEqual({ command: "pnpm test", status: "fail" });
});

// Usefulness: a loop with no finish shows a null summary and keeps the recorded error.
test("a loop with no finish shows a null summary and its error", () => {
  const report = buildLoopReport(
    { events: [{ type: "action", action: { action: "abort" } }], exitCode: 1, error: "stopped" },
    { attempts: 1 },
  );
  expect(report.summary).toBeNull();
  expect(report.error).toBe("stopped");
});

// Usefulness: a loop with no attempt and no transcript has an empty report instead of a failure.
test("a missing transcript of a loop with no attempt reads as an empty report", async () => {
  const dir = await tempDir();
  const report = await readLoopReport(join(dir, "missing.json"), { attempts: 0 });
  expect(report).toEqual({
    state: "no-attempt",
    summary: null,
    error: null,
    failedTurnTest: null,
    warnings: [],
    warningsOverflow: 0,
    transcriptRead: { ok: true },
  });
});

// Usefulness: a missing transcript of an attempted loop fails closed and keeps null warning and error fields.
test("a missing transcript of an attempted loop reports the unread state", async () => {
  const dir = await tempDir();
  const report = await readLoopReport(join(dir, "missing.json"), { attempts: 1 });
  expect(report.transcriptRead).toEqual({ ok: false, reason: "the transcript is missing" });
  expect(report.state).toBe("unread");
  expect(report.summary).toBeNull();
  expect(report.error).toBeNull();
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
});

// Usefulness: an empty or truncated transcript fails closed, so an unread record never looks empty.
test.each([
  ["an empty transcript", ""],
  ["a truncated last line", '{"events": [{"type": "action"'],
  ["a record that is not JSON", "not json"],
])("a readable file with %s reports the unread state", async (_name, text) => {
  const dir = await tempDir();
  const file = join(dir, "transcript.json");
  await writeFile(file, text);
  const report = await readLoopReport(file, { attempts: 1 });
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
  expect(report.error).toBeNull();
});

// Usefulness: a JSON record with a malformed event fails closed instead of reporting no warnings.
test("a malformed event in the transcript reports the unread state", () => {
  const report = buildLoopReport(
    { events: [finishEvent(SUMMARY), "not an event"], exitCode: 0, error: null },
    { attempts: 1 },
  );
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
});

// Usefulness: a transcript with fewer segments than attempts cannot describe the last attempt.
test("a transcript that does not cover the last attempt reports the unread state", () => {
  const report = buildLoopReport(
    { events: [finishEvent(SUMMARY), { type: "gate" }], exitCode: 0, error: null },
    { attempts: 2 },
  );
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.summary).toBeNull();
});

// Usefulness: warnings keep at most 20 entries and redact a secret-named environment value.
test("warnings keep 20 entries and redact a secret value", () => {
  const name = "AGENT_LOOP_REPORT_TEST_TOKEN";
  const secret = "a-very-secret-value";
  const before = process.env[name];
  process.env[name] = secret;
  try {
    const warnings = Array.from({ length: 25 }, (_, index) => `w${index} warning`);
    warnings[0] = `w00 warning ${secret}`;
    const report = buildLoopReport(
      { events: [{ type: "gate" }], exitCode: 1, error: null, warnings },
      { attempts: 1 },
    );
    expect(report.warnings).toHaveLength(20);
    expect(report.warningsOverflow).toBe(5);
    expect(report.warnings.join("\n")).not.toContain(secret);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

// Usefulness: a stored loop without a report reads as missing, not as no error and no warnings.
test("a missing stored report reads as missing", () => {
  const report = missingLoopReport();
  expect(report.state).toBe("missing");
  expect(report.transcriptRead.ok).toBe(false);
  expect(report.warnings).toBeNull();
  expect(report.warningsOverflow).toBeNull();
  expect(report.error).toBeNull();
});

// Usefulness: the transcript warning list and the report both keep 20 entries and report the overflow.
test("a transcript warning list is redacted, capped, and reports its overflow", async () => {
  const name = "AGENT_LOOP_REPORT_TEST_TOKEN";
  const secret = "a-very-secret-value";
  const before = process.env[name];
  process.env[name] = secret;
  try {
    const dir = await tempDir();
    const file = join(dir, "transcript.json");
    const writer = createTranscriptWriter({
      options: { transcript: file, testCmd: null, compareHead: null, mode: null },
      roles: {},
      events: [],
      reviewerSandbox: null,
    });
    const warnings = Array.from({ length: 25 }, (_, index) => `w${index} warning`);
    warnings[0] = `w00 warning ${secret}`;
    await withRunWarnings(writer.data.warnings, async () => {
      for (const warning of warnings) recordRunWarning(warning);
    });
    await writer.writeTranscript();
    const data = JSON.parse(await readFile(file, "utf8"));
    expect(data.warnings).toHaveLength(20);
    expect(data.warningsOverflow).toBe(5);
    expect(data.warnings.join("\n")).not.toContain(secret);
    const report = buildLoopReport(data, { attempts: 1 });
    expect(report.warnings).toHaveLength(20);
    expect(report.warningsOverflow).toBe(5);
    expect(report.warnings.join("\n")).not.toContain(secret);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});
