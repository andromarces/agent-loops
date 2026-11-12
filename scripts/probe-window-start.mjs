// Temporary probe for issue #1887. It measures the two watch-window sets on a CI runner.
// Each sample records the delta against Date.now() and against the performance clock.
// The offsets set shows how far the sub-millisecond clock reads above Date.now().
import { lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROUNDS = 200;
const RESTORE_WAIT_MS = 4;
const SETTLE_MS = 1;

/** Spins on the system clock until the deadline, so the delay stays sub-millisecond. */
function spinUntil(deadline) {
  while (Date.now() < deadline) {}
}

/** Spins a random part of one millisecond, so the start position is uniform. */
function spinRandomFraction() {
  spinUntil(Date.now() + Math.random());
}

/** Makes a timestamp-preserving change: two writes and a restore of the old times. */
async function preserveChange(file, old) {
  await writeFile(file, "copied\n");
  await writeFile(file, "hello\n");
  await utimes(file, old, old);
}

/** Returns the change time after the stamp settled to a stable reading. */
async function settledChangeTime(file) {
  const first = (await lstat(file)).ctimeMs;
  spinUntil(Date.now() + SETTLE_MS);
  const second = (await lstat(file)).ctimeMs;
  return Math.max(first, second);
}

/** Returns the sub-millisecond wall reading. */
function wallClock() {
  return performance.timeOrigin + performance.now();
}

const dir = await mkdtemp(join(tmpdir(), "probe-window-"));
const file = join(dir, "init.txt");
const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
const pre = [];
const restore = [];
const offsets = [];

await writeFile(file, "hello\n");
await utimes(file, old, old);

for (let round = 0; round < ROUNDS; round++) {
  // Set one: the change completes, then the window starts.
  spinRandomFraction();
  await preserveChange(file, old);
  const preNow = Date.now();
  const preWall = wallClock();
  const preChange = await settledChangeTime(file);
  pre.push({ n: preChange - preNow, p: preChange - preWall, o: preWall - preNow });

  // Set two: the window starts, then the change runs after the test wait.
  spinRandomFraction();
  const startNow = Date.now();
  const startWall = wallClock();
  spinUntil(startNow + RESTORE_WAIT_MS);
  await preserveChange(file, old);
  const restored = await settledChangeTime(file);
  restore.push({ n: restored - startNow, p: restored - startWall, o: startWall - startNow });
}

// A uniform sample of the step between the two clocks.
for (let index = 0; index < ROUNDS; index++) {
  spinRandomFraction();
  const now = Date.now();
  offsets.push(wallClock() - now);
}

/** Returns the sorted percentile of `values` at `fraction`. */
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/** Returns a one-line summary of one value list. */
function summarize(name, values) {
  return [
    `PROBE_SUMMARY set=${name}`,
    `count=${values.length}`,
    `min=${Math.min(...values).toFixed(3)}`,
    `p50=${percentile(values, 0.5).toFixed(3)}`,
    `p90=${percentile(values, 0.9).toFixed(3)}`,
    `p99=${percentile(values, 0.99).toFixed(3)}`,
    `max=${Math.max(...values).toFixed(3)}`,
  ].join(" ");
}

const round3 = (value) => Number(value.toFixed(3));
console.log(`PROBE_META platform=${process.platform} release=${process.version} rounds=${ROUNDS}`);
console.log(
  `PROBE_PRE ${JSON.stringify(pre.map((entry) => ({ n: round3(entry.n), p: round3(entry.p), o: round3(entry.o) })))}`,
);
console.log(
  `PROBE_RESTORE ${JSON.stringify(restore.map((entry) => ({ n: round3(entry.n), p: round3(entry.p), o: round3(entry.o) })))}`,
);
console.log(`PROBE_OFFSET ${JSON.stringify(offsets.map(round3))}`);
console.log(
  summarize(
    "pre.now",
    pre.map((entry) => entry.n),
  ),
);
console.log(
  summarize(
    "pre.performance",
    pre.map((entry) => entry.p),
  ),
);
console.log(
  summarize(
    "restore.now",
    restore.map((entry) => entry.n),
  ),
);
console.log(
  summarize(
    "restore.performance",
    restore.map((entry) => entry.p),
  ),
);
console.log(
  summarize(
    "pre.offset",
    pre.map((entry) => entry.o),
  ),
);
console.log(
  summarize(
    "restore.offset",
    restore.map((entry) => entry.o),
  ),
);
console.log(summarize("offset", offsets));
console.log(
  `PROBE_GAP now=${(Math.min(...restore.map((entry) => entry.n)) - Math.max(...pre.map((entry) => entry.n))).toFixed(3)} performance=${(Math.min(...restore.map((entry) => entry.p)) - Math.max(...pre.map((entry) => entry.p))).toFixed(3)}`,
);

await rm(dir, { recursive: true, force: true });
