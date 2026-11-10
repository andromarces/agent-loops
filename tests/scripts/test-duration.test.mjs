import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { formatSummary, readReport, summarizeReport } from "../../scripts/test-duration.mjs";

/** Builds one Vitest JSON file result with its assertions. */
function fileResult(name, startTime, endTime, assertions = []) {
  return { name, startTime, endTime, assertionResults: assertions };
}

/** Builds one Vitest JSON assertion result. */
function assertion(fullName, duration) {
  return { fullName, duration, status: "passed" };
}

// Usefulness: verifies the printed total is the measured elapsed time passed by the runner.
test("formatSummary prints the measured elapsed total", () => {
  const summary = summarizeReport({ testResults: [] });

  expect(formatSummary(summary, 4000)).toContain("Total wall time: 4.0 s");
});

// Usefulness: verifies file durations come from file timings, sorted longest first.
test("summarizeReport ranks files by their own duration", () => {
  const report = {
    startTime: 0,
    testResults: [
      fileResult("tests/slow.test.mjs", 0, 100, [assertion("slow test", 900)]),
      fileResult("tests/fast.test.mjs", 0, 4000),
    ],
  };

  const summary = summarizeReport(report);

  expect(summary.slowestFiles.map((file) => file.name)).toEqual([
    "tests/fast.test.mjs",
    "tests/slow.test.mjs",
  ]);
  expect(summary.slowestFiles[1].durationMs).toBe(100);
});

// Usefulness: verifies the file and test lists keep only the 20 longest entries.
test("summarizeReport cuts each list to the 20 slowest entries", () => {
  const report = {
    startTime: 0,
    testResults: Array.from({ length: 25 }, (_, index) =>
      fileResult(`tests/file-${index}.test.mjs`, 0, index + 1, [
        assertion(`test ${index}`, index + 1),
      ]),
    ),
  };

  const summary = summarizeReport(report);

  expect(summary.slowestFiles).toHaveLength(20);
  expect(summary.slowestFiles[0]).toEqual({
    name: "tests/file-24.test.mjs",
    durationMs: 25,
  });
  expect(summary.slowestTests).toHaveLength(20);
  expect(summary.slowestTests[0]).toEqual({ name: "test 24", durationMs: 25 });
});

// Usefulness: verifies a missing or unreadable report fails with the report path.
test("readReport rejects a missing or invalid report", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-duration-"));
  const missing = join(dir, "missing.json");
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, "{not json");

  try {
    expect(() => readReport(missing)).toThrow(missing);
    expect(() => readReport(invalid)).toThrow(invalid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
