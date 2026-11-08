# 0100. Arm the main work tree watch before the child turn

## Status

accepted

Partially supersedes [ADR 0080: Report a main work tree change that a turn restores inside its window](0080-report-a-main-work-tree-change-inside-a-turn-window.md), decision 1. It replaces decision 1's start rule. The start now waits for the `ready` promise that the watch factory supplies before it returns the handle. ADR 0080 decisions 2 to 8, its caps, its close-then-drain order, and its 1000 ms drain deadline stay in force. [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md) and its modification-time rule stay in force.

## Date

2026-11-08

## Context

A local probe on macOS 27.3 with Node v27.0.0-alpha.0.0.0 reopened one root and wrote once per iteration. A synchronous write right after `watch` missed 1 of 10,000 events. A write after one event-loop turn missed 0 of 5,000, and one after a 0 ms timer missed 0 of 5,000. The product watch missed 0 of 2,000 writes after the arm.

The probe does not establish the native cause. It shows that a write right after `watch` can be dropped and that one event-loop turn avoided the drop in the saved runs. Issue #1628 records three macOS CI misses and a local probe that reopened one root and missed a first write. The 5 in 1,000 reopen rate of #1544 was not reproduced.

## Decision

1. **Wait for `ready`.** `startMainWorkTreeWatch` resolves after the watch factory's `ready` promise. On macOS the default factory resolves `ready` after one event-loop turn. The other platforms return no `ready`, so their event handling does not change.
2. **One deadline.** The wait has one monotonic deadline of 1000 ms, computed with `performance.now`.
3. **Turn abort.** The turn abort signal ends the wait, closes the watch, and returns no handle.
4. **Failure.** A watch error, a watch close before the turn reads it, or a missed deadline reports no field and logs a warning. No path is dropped silently.
5. **Unchanged.** The caps, the overflow rule, the close-then-drain order, and the 1000 ms drain deadline of ADR 0080 stay unchanged.

## Consequences

- A child call starts after the macOS `ready` promise resolves, one event-loop turn after `watch`.
- A worker turn pays one event-loop turn on macOS, and no added wait on Linux or Windows.
- A `ready` promise that does not resolve costs the 1000 ms deadline, reports no field, and warns.
- A cancel during the wait closes the watch and returns no handle.
- The saved probe missed 1 in 10,000 writes right after `watch` and 0 in 5,000 after one event-loop turn. The product watch missed 0 in 2,000 writes after the arm. A rare OS-level drop outside this case stays possible. The 5 in 1,000 reopen rate of #1544 was not reproduced.

## Verification

### 2026-11-08 reopened-root first-write probe (macOS)

Host: macOS 27.3, build 26C5035r, arm64. Node v27.0.0-alpha.0.0.0. Source head `f6372334097fa322a97992cfe2b2e9a8ed8bce49`, which descends from `193d93c8`. The probe ran on one disposable Git repository root, under `node_modules/.cache/agent-loop-evidence/708/`.

- The probe called the real `startMainWorkTreeWatch` export. It followed the turn order: start, wait for the arm inside the start, write once, read the report, stop.
- Each of 1,000 iterations reopened that one root, wrote `init.txt` once after the start resolved, and waited for the first seen-file report.
- The bound for one write was 5,000 ms. The bound for the whole run was 540,000 ms.
- The miss count was 0 of 1,000 writes. The first report took 2.28 ms at the minimum, 12.6445 ms at the median, and 53.987 ms at the maximum.
- The mutant wrote inside `.git`, which the watch skips. The miss counter counted 3 of 3 iterations as a miss.
- Issue #1544 section 6 recorded 5 misses in 1,000 reopened-root writes. This probe recorded 0 misses in 1,000.

```js
// Reopened-root first-write probe for ADR 0100 (issue #708). One watched root, reopened per
// iteration: start the real watch, write once after the arm, wait for the first report, stop.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { startMainWorkTreeWatch } from "../../../../src/lib/main-work-tree-watch.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workTree = fileURLToPath(new URL("../../../../", import.meta.url));
const repo = join(here, "probe-repo");
const target = join(repo, "init.txt");
const mutant = process.argv[2] === "mutant";
const iterations = Number(process.argv[3] ?? (mutant ? 5 : 1000));
// Milliseconds that one write gets to appear as a seen file. The product drain deadline is 1000.
const REPORT_BOUND_MS = 5_000;
// Milliseconds that the whole run gets before it writes its partial summary and exits.
const WHOLE_RUN_MS = 540_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates the disposable probe repository once, with one tracked file. */
function initRepo() {
  mkdirSync(repo, { recursive: true });
  if (!existsSync(join(repo, ".git"))) {
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "probe@example.invalid");
    git("config", "user.name", "probe");
  }
  writeFileSync(target, "init\n");
  execFileSync("git", ["add", "init.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "probe", "--allow-empty"], { cwd: repo });
}

/** Runs one iteration and returns its record. A mutation writes inside `.git`, which the watch
 * skips, so the mutant counts every iteration as a miss. */
async function runIteration(i) {
  const started = performance.now();
  const handle = await startMainWorkTreeWatch(repo, {});
  const armedMs = performance.now() - started;
  if (handle === null) {
    return { i, reported: false, reason: "no-watch-handle", armedMs };
  }
  const writePath = mutant ? join(repo, ".git", "probe-mutant.txt") : target;
  const writeAt = performance.now();
  writeFileSync(writePath, `write ${i} ${Date.now()}\n`);
  let firstReportMs = null;
  while (performance.now() - writeAt <= REPORT_BOUND_MS) {
    if (handle.seenFileCount() > 0) {
      firstReportMs = performance.now() - writeAt;
      break;
    }
    await sleep(1);
  }
  const take = await handle.take().catch((err) => ({ candidates: [], failed: true, err }));
  await handle.stop();
  const relative = mutant ? ".git/probe-mutant.txt" : "init.txt";
  return {
    i,
    reported: firstReportMs !== null && take.candidates.includes(relative),
    firstReportMs: firstReportMs === null ? null : Math.round(firstReportMs * 1000) / 1000,
    takeMs: Math.round((performance.now() - writeAt) * 1000) / 1000,
    candidates: take.candidates,
    failed: take.failed === true,
    armedMs: Math.round(armedMs * 1000) / 1000,
  };
}

initRepo();
const sourceCommit = execFileSync("git", ["-C", workTree, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const swVers = execFileSync("sw_vers", { encoding: "utf8" }).trim();
const records = [];
const write = (name, body) => writeFileSync(join(here, name), body);
const finish = (exitCode) => {
  const misses = records.filter((record) => !record.reported).length;
  write(
    mutant ? "mutant.jsonl" : "iterations.jsonl",
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const summary = {
    probe: mutant ? "mutant" : "reopened-root",
    iterations: records.length,
    requestedIterations: iterations,
    misses,
    hitRate: `${records.length - misses}/${records.length}`,
    reportBoundMs: REPORT_BOUND_MS,
    wholeRunBoundMs: WHOLE_RUN_MS,
    platform: process.platform,
    arch: process.arch,
    macos: swVers,
    node: process.version,
    sourceCommit,
    completed: records.length === iterations,
  };
  write(mutant ? "mutant-summary.json" : "summary.json", JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary));
  process.exit(exitCode);
};
const watchdog = setTimeout(() => {
  finish(2);
}, WHOLE_RUN_MS);
for (let i = 1; i <= iterations; i++) records.push(await runIteration(i));
clearTimeout(watchdog);
finish(mutant && records.some((record) => record.reported) ? 1 : 0);
```

## Alternatives

1. **Write a sentinel file in the main work tree to test the watch.** Rejected. The watch observes user files, so the sentinel is a user-visible change.
2. **Wait for the first watch event as the ready signal.** Rejected. A turn that writes nothing never resolves it and fails.
3. **Rescan the main work tree at the turn end.** Rejected. It reads every main work tree entry on every turn, which the watch exists to avoid.
4. **Leave the start rule as it is.** Rejected. The reproduced right-after-`watch` miss stays.

## Authors

Andro Marces

## Links

- [Issue #1628](https://github.com/andromarces/agent-loops/issues/1628)
- [Issue #1544](https://github.com/andromarces/agent-loops/issues/1544)
- [Pull request #1629](https://github.com/andromarces/agent-loops/pull/1629)
- [ADR 0080](0080-report-a-main-work-tree-change-inside-a-turn-window.md) (decision 1 superseded)
- [ADR 0086](0086-leave-out-a-read-only-access-whose-modification-time-predates-the-turn-window.md)
- Implementation: `startMainWorkTreeWatch` and `watchRecursive` in `src/lib/main-work-tree-watch.mjs`
- Tests: `tests/lib/main-work-tree-watch.test.mjs`
- [ADR Index](README.md)
