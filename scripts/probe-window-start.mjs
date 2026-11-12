// Temporary probe for issue #1887. It measures the two watch-window sets on a CI runner.
// Each shard starts four child processes, so the samples cover distinct processes.
// The start copy mirrors `readWindowStart` and counts the accepted, retry, and fallback paths.
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
const START_READ_BOUND_MS = 0.5;

/** Spins on the system clock until the deadline, so the delay stays sub-millisecond. */
function spinUntil(deadline) {
  while (Date.now() < deadline) {}
}

/** Spins a random part of one millisecond, so the change position is uniform. */
function spinRandomFraction() {
  spinUntil(Date.now() + Math.random());
}

/** Mirrors the production window start and counts the path that each call took. */
function readWindowStart(paths) {
  const base = Date.now();
  const deadline = performance.now() + START_TICK_SPIN_MS;
  const origin = performance.now();
  let previous = origin;
  while (performance.now() < deadline) {
    const before = performance.now();
    const now = Date.now();
    const after = performance.now();
    const reliable =
      after - before <= START_READ_BOUND_MS && before - previous <= START_READ_BOUND_MS;
    previous = after;
    if (now === base) {
      if (!reliable) paths.retry++;
      continue;
    }
    if (!reliable || now !== base + 1) {
      paths.fallback++;
      return base + 1;
    }
    const elapsed = (before + after) / 2 - origin;
    if (elapsed > 1 + START_READ_BOUND_MS) {
      paths.fallback++;
      return base + 1;
    }
    paths.accepted++;
    return Math.min(base + 1, Math.max(base, base + 1 - elapsed));
  }
  paths.fallback++;
  return base + 1;
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
  const paths = { accepted: 0, retry: 0, fallback: 0 };
  await writeFile(file, "hello\n");
  await utimes(file, old, old);
  for (let round = 0; round < ROUNDS; round++) {
    spinRandomFraction();
    await preserveChange(file, old);
    const started = readWindowStart(paths);
    const change = await settledChangeTime(file);
    pre.push(round3(change - started));

    spinRandomFraction();
    const startBefore = Date.now();
    const startedRestore = readWindowStart(paths);
    spinUntil(startBefore + RESTORE_WAIT_MS);
    await preserveChange(file, old);
    const restored = await settledChangeTime(file);
    restore.push(round3(restored - startedRestore));
  }
  console.log(`PROBE_CHILD ${id} pre ${JSON.stringify(pre)}`);
  console.log(`PROBE_CHILD ${id} restore ${JSON.stringify(restore)}`);
  console.log(`PROBE_CHILD ${id} paths ${JSON.stringify(paths)}`);
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
