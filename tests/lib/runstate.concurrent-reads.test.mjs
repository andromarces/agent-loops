import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readStatesForSession, statePaths } from "../../src/lib/runstate.mjs";
import { restoreRunsRoot } from "../env-helpers.mjs";
import { removePath, trackedTempDir } from "../fs-helpers.mjs";

// Reads in flight at once, counted around every `readFile` call. Each read yields a turn so reads
// that start together overlap.
const reads = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    readFile: async (...args) => {
      reads.inFlight += 1;
      reads.peak = Math.max(reads.peak, reads.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await real.readFile(...args);
      } finally {
        reads.inFlight -= 1;
      }
    },
  };
});

let dirs = [];

afterEach(async () => {
  for (const dir of dirs) {
    await removePath(dir);
  }
  dirs = [];
  reads.inFlight = 0;
  reads.peak = 0;
});

// Usefulness: verifies a session with many runs never opens more than a bounded number of entry or
// state files at once (issue #1275), while every readable run is still returned in entry order and
// an unreadable one is skipped. No other test counts reads in flight.
test("readStatesForSession bounds the concurrent file reads and keeps entry order", async () => {
  process.env.AGENT_LOOP_RUNS_ROOT = await trackedTempDir("runstate-reads-", dirs);
  try {
    const { sessionRunsDir } = statePaths({
      cwd: await trackedTempDir("runstate-reads-cwd-", dirs),
      parentSession: "ses_many",
    });
    await mkdir(sessionRunsDir, { recursive: true });
    const stateDir = await trackedTempDir("runstate-reads-state-", dirs);
    const runs = 100;
    for (let i = 0; i < runs; i += 1) {
      const stateFile = join(stateDir, `state${i}.json`);
      // Run 7 has a missing state file and run 11 has a corrupt one: both are skipped.
      if (i !== 7) {
        await writeFile(stateFile, i === 11 ? "not json" : JSON.stringify({ n: i }), "utf8");
      }
      await writeFile(
        join(sessionRunsDir, `entry${String(i).padStart(3, "0")}`),
        stateFile,
        "utf8",
      );
    }

    const states = await readStatesForSession("ses_many");

    expect(states.map((state) => state.n)).toEqual(
      Array.from({ length: runs }, (_, i) => i).filter((i) => i !== 7 && i !== 11),
    );
    expect(reads.peak).toBeLessThanOrEqual(32);
  } finally {
    restoreRunsRoot();
  }
});
