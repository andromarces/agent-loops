import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { statePaths, writeState } from "../../src/lib/runstate.mjs";
import { writeSessionRecord } from "../../src/lib/session-record.mjs";
import { holdTestSlot } from "../../src/lib/test-slot.mjs";

// Usefulness: acceptance (#1022) — with no root variable set, a run state, a session record, and a test slot all land under `os.tmpdir()`, which is the per-file directory. The nested run in `tmpdir-isolation.test.mjs` starts this file with the three roots pinned, so a broken unset sends each write to a pinned path and fails here.
test("a default run state, session record, and test slot are written under the temp directory", async () => {
  // A wrapper that runs this file passes down a held-slot marker, which would skip the acquire.
  vi.stubEnv("AGENT_LOOP_TEST_SLOT_HELD", "");
  const work = await mkdtemp(join(tmpdir(), "default-roots-"));
  const writes = [];
  try {
    const { stateDir, stateFile } = statePaths({ cwd: work });
    await mkdir(stateDir, { recursive: true });
    await writeState(stateFile, {});
    writes.push(stateDir);

    await writeSessionRecord(join(work, "run.json"), {
      cwd: work,
      runNonce: "33333333-3333-4333-8333-333333333333",
      transcriptSha256: "a".repeat(64),
      role: "reviewer",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    writes.push(join(tmpdir(), "agent-loops", "session-records"));

    const slot = await holdTestSlot({
      slots: 1,
      waitSeconds: 5,
      signal: new AbortController().signal,
    });
    expect(slot).not.toBeNull();
    expect(slot.nested).toBe(false);
    // The lock file exists only while the slot is held.
    writes.push(join(tmpdir(), "agent-loops", "test-slots"));
    for (const path of writes) {
      expect((await readdir(path)).length).toBeGreaterThan(0);
    }
    await slot.release();
  } finally {
    vi.unstubAllEnvs();
    await rm(work, { recursive: true, force: true });
  }
});
