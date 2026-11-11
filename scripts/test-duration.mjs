import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SLOWEST = 20;

/** Reads a Vitest JSON report, with the report path in every failure message. */
export function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`No readable test report at ${path}: ${error.message}`);
  }
}

function durationBetween(startTime, endTime) {
  const start = Number(startTime);
  const end = Number(endTime);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function displayName(name) {
  return isAbsolute(name) ? relative(process.cwd(), name) : name;
}

function slowest(entries, limit) {
  return entries
    .toSorted(
      (left, right) => right.durationMs - left.durationMs || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

/** Ranks files and tests by duration, longest first. */
export function summarizeReport(report, limit = SLOWEST) {
  const files = report.testResults ?? [];
  const slowestFiles = slowest(
    files.map((file) => ({
      name: displayName(file.name),
      durationMs: durationBetween(file.startTime, file.endTime),
    })),
    limit,
  );
  const slowestTests = slowest(
    files.flatMap((file) =>
      (file.assertionResults ?? []).map((test) => ({
        name: test.fullName,
        durationMs: Number.isFinite(Number(test.duration)) ? Math.max(0, Number(test.duration)) : 0,
      })),
    ),
    limit,
  );

  return { slowestFiles, slowestTests };
}

function formatDuration(ms) {
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatList(title, entries) {
  const lines = entries.map(
    (entry, index) =>
      `${String(index + 1).padStart(2)}. ${formatDuration(entry.durationMs).padStart(8)}  ${entry.name}`,
  );
  return [title, ...lines].join("\n");
}

/** Renders the summary and measured total as one text block for stdout. */
export function formatSummary(summary, totalMs) {
  return [
    `Total wall time: ${formatDuration(totalMs)}`,
    formatList("Slowest test files:", summary.slowestFiles),
    formatList("Slowest tests:", summary.slowestTests),
  ].join("\n\n");
}

function vpBinPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("vite-plus/package.json")), "bin", "vp");
}

/** Builds the Vitest arguments that keep console output and write a JSON report. */
export function testArguments(reportPath) {
  return [
    vpBinPath(),
    "test",
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportPath}`,
  ];
}

function main() {
  const reportPath = join(tmpdir(), `agent-loops-test-duration-${process.pid}.json`);
  try {
    const started = performance.now();
    const run = spawnSync(process.execPath, testArguments(reportPath), { stdio: "inherit" });
    const elapsedMs = performance.now() - started;
    if (run.error) throw run.error;
    if (run.signal) throw new Error(`Test run ended by signal ${run.signal}`);

    const report = readReport(reportPath);
    process.stdout.write(`${formatSummary(summarizeReport(report), elapsedMs)}\n`);
    if (run.status !== 0 || report.success === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(reportPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
