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

const childResult = (role, report) => ({ type: "result", role, result: { status: "ok", report } });

const TURN_REPORT = {
  conclusion: "the turn ended",
  why: "the reason",
  blockers: "the owner decision",
  checks: null,
  notes: "a later check",
  deferred: "the follow-up work",
};

// Usefulness: a failed loop with no finish keeps the last child turn items beside a null summary.
test("a failed loop with no finish keeps the last child turn items", () => {
  const report = buildLoopReport(
    {
      events: [
        { type: "action", action: { action: "run_worker" } },
        childResult("worker", TURN_REPORT),
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.summary).toBeNull();
  expect(report.lastTurnItems).toEqual({
    role: "worker",
    deferred: "the follow-up work",
    notes: "a later check",
    blockers: "the owner decision",
    reason: null,
  });
});

// Usefulness: an interrupted loop with no finish keeps the last child turn items.
test("an interrupted loop with no finish keeps the last child turn items", () => {
  const report = buildLoopReport(
    {
      events: [childResult("worker", TURN_REPORT)],
      exitCode: 130,
      error: "the run was interrupted",
    },
    { attempts: 1 },
  );
  expect(report.summary).toBeNull();
  expect(report.lastTurnItems.notes).toBe("a later check");
  expect(report.lastTurnItems.deferred).toBe("the follow-up work");
});

// Usefulness: a needs-owner loop with no finish keeps the last child turn items.
test("a needs-owner loop with no finish keeps the last child turn items", () => {
  const report = buildLoopReport(
    { events: [childResult("worker", TURN_REPORT)], exitCode: 4, error: null },
    { attempts: 1 },
  );
  expect(report.summary).toBeNull();
  expect(report.lastTurnItems.blockers).toBe("the owner decision");
});

// Usefulness: a finish summary keeps the current report shape and gains no last-turn field.
test("a finished loop report gains no last-turn items field", () => {
  const report = buildLoopReport(
    {
      events: [childResult("worker", TURN_REPORT), finishEvent(SUMMARY)],
      exitCode: 0,
      error: null,
    },
    { attempts: 1 },
  );
  expect(report.summary).toEqual({ ...SUMMARY, notes: null });
  expect(report).not.toHaveProperty("lastTurnItems");
});

// Usefulness: a no-finish report redacts a secret-named environment value in the copied items.
test("last-turn items redact a secret-named environment value", () => {
  const name = "AGENT_LOOP_REPORT_TEST_TOKEN";
  const secret = "a-very-secret-value";
  const before = process.env[name];
  process.env[name] = secret;
  try {
    const report = buildLoopReport(
      {
        events: [
          childResult("worker", {
            ...TURN_REPORT,
            notes: `the note ${secret}`,
            deferred: `the work ${secret}`,
            blockers: `the blocker ${secret}`,
          }),
        ],
        exitCode: 1,
      },
      { attempts: 1 },
    );
    const copied = JSON.stringify(report.lastTurnItems);
    expect(copied).not.toContain(secret);
    expect(report.lastTurnItems.notes).toContain("[redacted:");
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

// Usefulness: a last child result without a parsed report states that and leaves every item null.
test("a last child turn without a parsed report states the missing report", () => {
  const report = buildLoopReport(
    {
      events: [{ type: "result", role: "worker", result: { status: "ok", report: null } }],
      exitCode: 1,
    },
    { attempts: 1 },
  );
  expect(report.lastTurnItems).toEqual({
    role: "worker",
    deferred: null,
    notes: null,
    blockers: null,
    reason: "the last child turn has no parsed report",
  });
});

// Usefulness: a last attempt without a child result states that and leaves every item null.
test("a last attempt without a child result states the missing result", () => {
  const report = buildLoopReport(
    { events: [{ type: "action", action: { action: "abort" } }], exitCode: 1 },
    { attempts: 1 },
  );
  expect(report.lastTurnItems).toEqual({
    role: null,
    deferred: null,
    notes: null,
    blockers: null,
    reason: "the last attempt holds no child result",
  });
});

// Usefulness: an unread report fails closed and gains no last-turn items field.
test("an unread report gains no last-turn items field", () => {
  const report = buildLoopReport({ events: [{ type: "result" }, "broken"] }, { attempts: 1 });
  expect(report.state).toBe("unread");
  expect(report).not.toHaveProperty("lastTurnItems");
});

// Usefulness: a missing report fails closed and gains no last-turn items field.
test("a missing report gains no last-turn items field", () => {
  expect(missingLoopReport()).not.toHaveProperty("lastTurnItems");
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

// Usefulness: a review-only reject keeps its actionable blocker apart from notes that read none.
test("a review-only report keeps the blockers in their own field", () => {
  const report = buildLoopReport(
    {
      events: [
        {
          type: "result",
          role: "reviewer",
          result: {
            status: "ok",
            response: "Conclusion: no.\n\nVerdict: reject",
            report: { verdict: "reject", blockers: "fix the guard", notes: "none" },
          },
        },
        { type: "gate" },
      ],
      exitCode: 0,
    },
    { attempts: 1, reviewOnly: true },
  );
  expect(report.verdict).toBe("reject");
  expect(report.reviewerBlockers).toContain("fix the guard");
  expect(report.reviewerBlockers).not.toBe("none");
  expect(report.reviewerNotes).toBeNull();
  expect(report.reviewerFindings).toBeNull();
  expect(report.reviewerDeferred).toBeNull();
});

// Usefulness: a reader tells a finding from a blocker, a note, and a deferred item by its field.
test("a review-only report keeps findings, blockers, notes, and deferred apart", () => {
  const report = buildLoopReport(
    {
      events: [
        {
          type: "result",
          role: "reviewer",
          result: {
            status: "ok",
            response: "Verdict: reject",
            report: {
              verdict: "reject",
              findings: ["the first finding"],
              blockers: "fix the guard",
              notes: "a later check",
              deferred: ["a live run"],
            },
          },
        },
        { type: "gate" },
      ],
      exitCode: 0,
    },
    { attempts: 1, reviewOnly: true },
  );
  expect(report.verdict).toBe("reject");
  expect(report.reviewerFindings).toEqual(["the first finding"]);
  expect(report.reviewerBlockers).toBe("fix the guard");
  expect(report.reviewerNotes).toBe("a later check");
  expect(report.reviewerDeferred).toEqual(["a live run"]);
});

// Usefulness: a runtime-capped list uses its source total to name the dropped entries.
test("a failed-turn test list uses the source count for its overflow", () => {
  const changedPaths = Array.from({ length: 20 }, (_, index) => `path ${index}`);
  const report = buildLoopReport(
    {
      events: [
        {
          type: "test-run",
          fatal: true,
          testRun: { changedPaths, changedCount: 25 },
        },
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.failedTurnTest.changedPaths).toHaveLength(20);
  expect(report.failedTurnTest.changedPathsOverflow).toBe(5);
});

// Usefulness: an invalid source count falls back to the local cap count and never goes negative.
test("a failed-turn test list keeps a non-negative overflow from a bad source count", () => {
  const changedPaths = Array.from({ length: 22 }, (_, index) => `path ${index}`);
  const report = buildLoopReport(
    {
      events: [
        {
          type: "test-run",
          fatal: true,
          testRun: { changedPaths, changedCount: -1 },
        },
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.failedTurnTest.changedPaths).toHaveLength(20);
  expect(report.failedTurnTest.changedPathsOverflow).toBe(2);
});

// Usefulness: a capped late-change list uses its source total to name the dropped entries.
test("a failed-turn test late-change list uses the source total", () => {
  const lateChangedPaths = Array.from({ length: 20 }, (_, index) => `late ${index}`);
  const report = buildLoopReport(
    {
      events: [
        {
          type: "test-run",
          fatal: true,
          testRun: { lateChangedPaths, lateChangedCount: 25 },
        },
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.failedTurnTest.lateChangedPaths).toHaveLength(20);
  expect(report.failedTurnTest.lateChangedPathsOverflow).toBe(5);
});

// Usefulness: a capped reviewer list names its dropped count, so a reader does not take it as full.
test("a reviewer findings list of 21 or more keeps 20 entries and counts the rest", () => {
  const findings = Array.from({ length: 25 }, (_, index) => `finding ${index}`);
  const report = buildLoopReport(
    {
      events: [
        {
          type: "result",
          role: "reviewer",
          result: { status: "ok", response: "Verdict: accept", report: { findings } },
        },
      ],
      exitCode: 0,
    },
    { attempts: 1, reviewOnly: true },
  );
  expect(report.reviewerFindings).toHaveLength(20);
  expect(report.reviewerFindingsOverflow).toBe(5);
});

// Usefulness: a reviewer list of exactly 20 entries names no dropped entry.
test("a reviewer findings list of 20 entries reports no overflow", () => {
  const findings = Array.from({ length: 20 }, (_, index) => `finding ${index}`);
  const report = buildLoopReport(
    {
      events: [
        {
          type: "result",
          role: "reviewer",
          result: { status: "ok", response: "Verdict: accept", report: { findings } },
        },
      ],
      exitCode: 0,
    },
    { attempts: 1, reviewOnly: true },
  );
  expect(report.reviewerFindings).toHaveLength(20);
  expect(report.reviewerFindingsOverflow).toBe(0);
});

// Usefulness: a capped array inside the failed-turn test names its dropped count beside it.
test("a capped failed-turn test array counts the entries it dropped", () => {
  const command = Array.from({ length: 22 }, (_, index) => `command ${index}`);
  const report = buildLoopReport(
    {
      events: [
        { type: "test-run", fatal: true, testRun: { command, status: "fail" } },
        { type: "gate" },
      ],
      exitCode: 1,
      error: "the turn failed",
    },
    { attempts: 1 },
  );
  expect(report.failedTurnTest.command).toHaveLength(20);
  expect(report.failedTurnTest.commandOverflow).toBe(2);
});

// Usefulness: a reviewer list redacts a secret-named environment value at the report boundary.
test("a reviewer findings list redacts a secret-named environment value", () => {
  const name = "AGENT_LOOP_REPORT_TEST_TOKEN";
  const secret = "a-very-secret-value";
  const before = process.env[name];
  process.env[name] = secret;
  try {
    const findings = Array.from({ length: 21 }, (_, index) => `finding ${index}`);
    findings[0] = `finding ${secret}`;
    const report = buildLoopReport(
      {
        events: [
          {
            type: "result",
            role: "reviewer",
            result: { status: "ok", response: "Verdict: accept", report: { findings } },
          },
        ],
        exitCode: 0,
      },
      { attempts: 1, reviewOnly: true },
    );
    expect(report.reviewerFindings).toHaveLength(20);
    expect(report.reviewerFindingsOverflow).toBe(1);
    expect(report.reviewerFindings.join("\n")).not.toContain(secret);
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});
