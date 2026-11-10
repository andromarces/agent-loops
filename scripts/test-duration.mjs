import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
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

/** Ranks files and tests by duration and measures wall time from report start to last end. */
export function summarizeReport(report, limit = SLOWEST) {
  const files = report.testResults ?? [];
  const starts = files.map((file) => Number(file.startTime)).filter(Number.isFinite);
  const ends = files.map((file) => Number(file.endTime)).filter(Number.isFinite);
  const reportStart = Number(report.startTime);
  if (Number.isFinite(reportStart)) starts.push(reportStart);

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

  const totalMs =
    starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;

  return { totalMs, slowestFiles, slowestTests };
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

/** Renders the summary as one text block for stdout. */
export function formatSummary(summary) {
  return [
    `Total wall time: ${formatDuration(summary.totalMs)}`,
    formatList("Slowest test files:", summary.slowestFiles),
    formatList("Slowest tests:", summary.slowestTests),
  ].join("\n\n");
}

function vpBinPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("vite-plus/package.json")), "bin", "vp");
}

function main() {
  const reportPath = join(tmpdir(), `agent-loops-test-duration-${process.pid}.json`);
  try {
    const run = spawnSync(
      process.execPath,
      [vpBinPath(), "test", "run", "--reporter=json", `--outputFile=${reportPath}`],
      { stdio: "inherit" },
    );
    if (run.error) throw run.error;

    const report = readReport(reportPath);
    process.stdout.write(`${formatSummary(summarizeReport(report))}\n`);
    if (run.status !== 0 || report.success === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(reportPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
