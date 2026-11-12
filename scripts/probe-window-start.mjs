// Temporary probe for issue #1887. It measures two sets on a CI runner.
// Set one is a pre-window change time minus the window start.
// Set two is an in-window timestamp-preserving restore minus the window start.
// Each sample also records the fractional system clock reading, so the integer
// step of Date.now() is separable from the rest of the delta.
import { lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROUNDS = 200;
const RESTORE_DELAYS_MS = [4, 6, 8];
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

/** Returns the change time in milliseconds after the stamp settled. */
async function settledChangeTime(file) {
  const first = (await lstat(file)).ctimeMs;
  spinUntil(Date.now() + SETTLE_MS);
  const second = (await lstat(file)).ctimeMs;
  return { change: Math.max(first, second), fraction: second % 1 };
}

const dir = await mkdtemp(join(tmpdir(), "probe-window-"));
const file = join(dir, "init.txt");
const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
const pre = [];
const restore = new Map(RESTORE_DELAYS_MS.map((delay) => [delay, []]));
const clockPairs = [];

await writeFile(file, "hello\n");
await utimes(file, old, old);

for (let round = 0; round < ROUNDS; round++) {
  // Set one: the change completes, then the window starts.
  spinRandomFraction();
  await preserveChange(file, old);
  const preStart = Date.now();
  const preClock = performance.timeOrigin + performance.now();
  const preChange = await settledChangeTime(file);
  pre.push({
    delta: preChange.change - preStart,
    fraction: preClock - preStart,
    stamp: preChange.fraction,
  });

  // Set two: the window starts, then the change runs after the delay.
  for (const delay of RESTORE_DELAYS_MS) {
    spinRandomFraction();
    const start = Date.now();
    const clock = performance.timeOrigin + performance.now();
    spinUntil(start + delay);
    await preserveChange(file, old);
    const change = await settledChangeTime(file);
    restore.get(delay).push({
      delta: change.change - start,
      fraction: clock - start,
      stamp: change.fraction,
    });
  }
}

// The integer step of Date.now() against a sub-millisecond clock reading.
for (let index = 0; index < 2 * ROUNDS; index++) {
  const now = Date.now();
  const sub = performance.timeOrigin + performance.now();
  clockPairs.push(sub - now);
}

/** Returns the sorted percentile of `values` at `fraction`. */
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

/** Returns a one-line summary of one set. */
function summarize(name, values, thresholds) {
  const above = thresholds.map(
    (threshold) => `above${threshold}=${values.filter((value) => value > threshold).length}`,
  );
  return [
    `PROBE_SUMMARY set=${name}`,
    `count=${values.length}`,
    `min=${Math.min(...values).toFixed(3)}`,
    `p50=${percentile(values, 0.5).toFixed(3)}`,
    `p90=${percentile(values, 0.9).toFixed(3)}`,
    `p99=${percentile(values, 0.99).toFixed(3)}`,
    `max=${Math.max(...values).toFixed(3)}`,
    ...above,
  ].join(" ");
}

const round3 = (value) => Number(value.toFixed(3));
console.log(`PROBE_META platform=${process.platform} release=${process.version} rounds=${ROUNDS}`);
console.log(
  `PROBE_PRE ${JSON.stringify(pre.map((entry) => ({ d: round3(entry.delta), f: round3(entry.fraction), s: round3(entry.stamp) })))}`,
);
for (const delay of RESTORE_DELAYS_MS) {
  const values = restore.get(delay);
  console.log(
    `PROBE_RESTORE_${delay} ${JSON.stringify(values.map((entry) => ({ d: round3(entry.delta), f: round3(entry.fraction), s: round3(entry.stamp) })))}`,
  );
}
console.log(`PROBE_CLOCK ${JSON.stringify(clockPairs.map(round3))}`);
console.log(
  summarize(
    "pre",
    pre.map((entry) => entry.delta),
    [2.5, 3, 3.5, 4, 5, 6],
  ),
);
console.log(
  summarize(
    "preMinusFraction",
    pre.map((entry) => entry.delta - entry.fraction),
    [],
  ),
);
console.log(
  summarize(
    "preStamp",
    pre.map((entry) => entry.stamp),
    [],
  ),
);
for (const delay of RESTORE_DELAYS_MS) {
  console.log(
    summarize(
      `restore_${delay}`,
      restore.get(delay).map((entry) => entry.delta),
      [2.5, 3, 3.5, 4, 5, 6],
    ),
  );
  console.log(
    summarize(
      `restore_${delay}_minusFraction`,
      restore.get(delay).map((entry) => entry.delta - entry.fraction),
      [],
    ),
  );
}
console.log(
  summarize(
    "fraction",
    pre.map((entry) => entry.fraction),
    [],
  ),
);
console.log(summarize("dateNowMinusSubMillisecondClock", clockPairs, []));

await rm(dir, { recursive: true, force: true });
