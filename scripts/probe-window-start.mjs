// Temporary probe for issue #1887. It measures the two watch-window sets on a CI runner.
// Each shard starts four child processes, so the samples cover distinct processes.
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROUNDS = 50;
const RESTORE_WAIT_MS = 4;
const SETTLE_MS = 1;
const CHILDREN = 4;
const START_TICK_SPIN_MS = 2;

/** Spins on the system clock until the deadline, so the delay stays sub-millisecond. */
function spinUntil(deadline) {
  while (Date.now() < deadline) {}
}

/** Spins a random part of one millisecond, so the change position is uniform. */
function spinRandomFraction() {
  spinUntil(Date.now() + Math.random());
}

/** Mirrors the production window start, with the performance clock as an elapsed timer only. */
function readWindowStart() {
  const base = Date.now();
  const began = performance.now();
  let current = base;
  while (current === base) {
    if (performance.now() - began >= START_TICK_SPIN_MS) return base;
    current = Date.now();
  }
  const elapsed = performance.now() - began;
  return current === base + 1 ? base + 1 - elapsed : current;
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

const round3 = (value) => Number(value.toFixed(3));

/** Runs one child process measurement and prints its samples. */
async function runChild(id) {
  const dir = await mkdtemp(join(tmpdir(), "probe-window-"));
  const file = join(dir, "init.txt");
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const pre = [];
  const restore = [];
  const start = [];
  await writeFile(file, "hello\n");
  await utimes(file, old, old);
  for (let round = 0; round < ROUNDS; round++) {
    spinRandomFraction();
    await preserveChange(file, old);
    const before = Date.now();
    const started = readWindowStart();
    const change = await settledChangeTime(file);
    pre.push(round3(change - started));
    start.push(round3(started - before));

    spinRandomFraction();
    const startBefore = Date.now();
    const startedRestore = readWindowStart();
    spinUntil(startBefore + RESTORE_WAIT_MS);
    await preserveChange(file, old);
    const restored = await settledChangeTime(file);
    restore.push(round3(restored - startedRestore));
  }
  console.log(`PROBE_CHILD ${id} pre ${JSON.stringify(pre)}`);
  console.log(`PROBE_CHILD ${id} restore ${JSON.stringify(restore)}`);
  console.log(`PROBE_CHILD ${id} start ${JSON.stringify(start)}`);
  await rm(dir, { recursive: true, force: true });
}

/** Runs one child process per measurement and prints its output. */
async function runParent() {
  console.log(
    `PROBE_META platform=${process.platform} release=${process.version} rounds=${ROUNDS} children=${CHILDREN}`,
  );
  for (let id = 1; id <= CHILDREN; id++) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child", String(id)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    if (code !== 0) throw new Error(`probe child ${id} exited ${code}`);
    process.stdout.write(output);
  }
}

if (process.argv[2] === "child") await runChild(Number(process.argv[3]));
else await runParent();
