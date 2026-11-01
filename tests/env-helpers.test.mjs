import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";

// Usefulness: acceptance (#1022) — a runs-root pin inherited before isolation starts must not come back through `restoreRunsRoot`, or default run paths escape the per-file directory.
test("restoreRunsRoot leaves the runs root unset even when the helpers loaded under an inherited pin", async () => {
  const before = process.env.AGENT_LOOP_RUNS_ROOT;
  try {
    process.env.AGENT_LOOP_RUNS_ROOT = join(tmpdir(), "sentinel-real-root", "runs");
    vi.resetModules();
    const helpers = await import("./env-helpers.mjs");
    process.env.AGENT_LOOP_RUNS_ROOT = join(tmpdir(), "test-set-root");
    helpers.restoreRunsRoot();
    expect(process.env.AGENT_LOOP_RUNS_ROOT).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.AGENT_LOOP_RUNS_ROOT;
    else process.env.AGENT_LOOP_RUNS_ROOT = before;
  }
});
