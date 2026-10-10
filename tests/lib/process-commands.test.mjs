import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { refuseHeldSessions } from "../../src/lib/continuation.mjs";
import { readProcessCommands } from "../../src/lib/process-ancestry.mjs";
import { removePath } from "../runtime-helpers.mjs";

const HELD_ID = "11111111-2222-4333-8444-555555555555";
const roles = {
  orchestrator: { kind: "codex", sessionId: null },
  worker: { kind: "claude", sessionId: HELD_ID },
  reviewer: { kind: "codex", sessionId: null },
};

let shimDir;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (shimDir) {
    await removePath(shimDir);
    shimDir = undefined;
  }
});

// A `ps` that never answers stands for a stalled process-table read. The shim is POSIX only,
// and the Windows read goes through the same `exec` options.
async function stallPs() {
  shimDir = await mkdtemp(join(tmpdir(), "stalled-ps-"));
  await writeFile(join(shimDir, "ps"), "#!/bin/sh\nexec sleep 30\n");
  await chmod(join(shimDir, "ps"), 0o755);
  vi.stubEnv("PATH", `${shimDir}${delimiter}${process.env.PATH}`);
}

// Usefulness: verifies a SIGINT-style cancel ends a stalled process-table read at once, so the
// holder check cannot defeat cancellation of the run (#647). No other test stalls the read.
test.skipIf(process.platform === "win32")(
  "refuseHeldSessions ends a stalled process-table read when the run is canceled",
  async () => {
    await stallPs();
    const controller = new AbortController();
    const started = Date.now();
    const check = refuseHeldSessions(roles, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(check).rejects.toMatchObject({ isCanceled: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);

// Usefulness: verifies the read has a bound, so a stalled `ps` or PowerShell cannot hold a
// continued run forever. The run then warns and continues.
test.skipIf(process.platform === "win32")(
  "refuseHeldSessions gives up on a stalled process-table read after its bound",
  async () => {
    await stallPs();
    const started = Date.now();
    await expect(refuseHeldSessions(roles, { timeout: 1 })).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  },
);

// Usefulness: verifies the read itself reports a cancel as an error and not as an empty table.
test.skipIf(process.platform === "win32")(
  "readProcessCommands rejects when canceled mid-read",
  async () => {
    await stallPs();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(readProcessCommands({ signal: controller.signal })).rejects.toMatchObject({
      isCanceled: true,
    });
  },
);
