import { delimiter } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { exec } from "../../src/lib/exec.mjs";
import {
  harnessForProcessName,
  nearestHarness,
  readProcessCommands,
  readProcessTable,
} from "../../src/lib/process-ancestry.mjs";
import {
  BOUND_KILL_TEST_TIMEOUT_MS,
  createPsShim,
  expectBoundKillsShim,
} from "../process-helpers.mjs";
import { within } from "../wait-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, exec: vi.fn(real.exec) };
});

const SENTINEL = "SECRET-SENTINEL-4f9a1c";
const posix = process.platform !== "win32";
let shim;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await shim?.cleanup();
  shim = undefined;
});

async function useShim(body, options) {
  shim = await createPsShim(body, options);
  vi.stubEnv("PATH", `${shim.dir}${delimiter}${process.env.PATH}`);
}

// Runs `fn` and returns what it threw with everything the run printed.
async function failureAndOutput(fn) {
  const lines = [];
  for (const method of ["log", "error", "warn", "info"]) {
    vi.spyOn(console, method).mockImplementation((...args) => lines.push(args.join(" ")));
  }
  const error = await within(
    fn().catch((err) => err),
    20_000,
    "The read",
  );
  return { error, printed: lines.join("\n") };
}

// Usefulness: verifies the process-ancestry mechanism — the nearest harness
// above the shell decides the running harness, an unknown or missing ancestor
// returns null, and a nested Copilot session under a Codex shell resolves to
// Copilot.
test("nearestHarness resolves the running harness and fails closed when absent", async () => {
  const table = [
    { pid: 10, ppid: 1, name: "codex.exe" },
    { pid: 20, ppid: 10, name: "cmd.exe" },
    { pid: 30, ppid: 20, name: "node.exe" },
    { pid: 40, ppid: 30, name: "bash" },
    { pid: 50, ppid: 40, name: "copilot.exe" },
  ];
  const readProcesses = async () => table;
  expect(await nearestHarness({ startPid: 40, readProcesses })).toBe("codex");
  expect(await nearestHarness({ startPid: 50, readProcesses })).toBe("copilot");
  expect(await nearestHarness({ startPid: 999, readProcesses })).toBe(null);
  expect(await nearestHarness({ startPid: 0, readProcesses })).toBe(null);
});

test("harnessForProcessName maps harness binaries and rejects others", () => {
  expect(harnessForProcessName("codex.exe")).toBe("codex");
  expect(harnessForProcessName("C:\\tools\\opencode.cmd")).toBe("opencode");
  expect(harnessForProcessName("agy")).toBe("antigravity");
  expect(harnessForProcessName("antigravity.exe")).toBe("antigravity");
  expect(harnessForProcessName("bash")).toBe(null);
  expect(harnessForProcessName("")).toBe(null);
});

// Usefulness: verifies the read has the 30-second default bound when the caller sets none (#647).
// A test of the observable effect would stall for the full 30 s, which is too slow for the suite,
// so this keeps the narrowest assertion, on the option that `exec` receives. A shim `ps` answers
// at once, so the read does not depend on the host `ps`.
test.skipIf(!posix)("readProcessCommands bounds the read at 30 seconds by default", async () => {
  await useShim("echo '1 init'");
  await expect(readProcessCommands()).resolves.toEqual([{ pid: 1, command: "init" }]);
  expect(vi.mocked(exec).mock.lastCall[2]).toMatchObject({ timeout: 30 });
});

// Usefulness: verifies a failed read reports its reason class and never process-table output,
// because the output holds the command lines of every process on the host (#647).
test.skipIf(!posix)(
  "readProcessCommands names the exit code and no output of a failing read",
  async () => {
    await useShim(`echo ${SENTINEL}\necho ${SENTINEL} >&2\nexit 3`);
    const { error, printed } = await failureAndOutput(() => readProcessCommands());
    expect(error.reason).toBe("exited with code 3");
    expect(JSON.stringify([error.message, error.reason, error.stack])).not.toContain(SENTINEL);
    expect(printed).not.toContain(SENTINEL);
  },
);

// Usefulness: verifies the timeout of a read that already wrote output names only the reason
// class, and that `exec` ends the stalled shim before its own ceiling, so the read outlives
// neither the bound nor the force-kill delay that follows it. The shim ignores SIGTERM and ends
// by itself at 20 s (21.2 s at most), well after the 6 s force kill.
test.skipIf(!posix)(
  "readProcessCommands names the timeout and ends the stalled process",
  async () => {
    await useShim(`echo ${SENTINEL}\necho ${SENTINEL} >&2\ntrap '' TERM\n__STALL__`, {
      ceilingSeconds: 20,
    });
    const started = Date.now();
    const { error, printed } = await failureAndOutput(() => readProcessCommands({ timeout: 1 }));
    expect(error.reason).toBe("timed out after 1 second");
    expect(JSON.stringify([error.message, error.reason])).not.toContain(SENTINEL);
    expect(printed).not.toContain(SENTINEL);
    // The shell ignores SIGTERM, so the read ends at the 1 s bound plus the 5 s force-kill delay.
    expect(Date.now() - started).toBeLessThan(12_000);
    // Secondary evidence: the heartbeat of the shim stopped and its marker is absent.
    expect(await shim.heartbeatStopped()).toBe(true);
  },
  40_000,
);

// Usefulness: verifies a cancel that arrives while the read runs names only the reason class and
// that `exec` ends the shim before its 10 s ceiling (11.2 s at most).
test.skipIf(!posix)(
  "readProcessCommands names the cancel and ends the stalled process",
  async () => {
    await useShim(`echo ${SENTINEL}\necho ${SENTINEL} >&2\n__STALL__`);
    const controller = new AbortController();
    const read = failureAndOutput(() => readProcessCommands({ signal: controller.signal }));
    await shim.ready();
    const canceledAt = Date.now();
    controller.abort();
    const { error, printed } = await read;
    // Primary evidence: the read rejected as canceled, well inside the 5 s force-kill delay.
    expect(Date.now() - canceledAt).toBeLessThan(5000);
    expect(error).toMatchObject({ isCanceled: true, reason: "was canceled" });
    expect(JSON.stringify([error.message, error.reason])).not.toContain(SENTINEL);
    expect(printed).not.toContain(SENTINEL);
    // Secondary evidence: the heartbeat of the shim stopped and its marker is absent.
    expect(await shim.heartbeatStopped()).toBe(true);
  },
  30_000,
);

// Usefulness: verifies the ancestry read returns pid, parent pid, and name rows through the merged
// reader, which the harness lookup depends on (#729).
test.skipIf(!posix)("readProcessTable lists pid, parent pid, and name", async () => {
  await useShim("echo '  7  1 launchd'\necho '42 7 my shell'");
  await expect(readProcessTable()).resolves.toEqual([
    { pid: 7, ppid: 1, name: "launchd" },
    { pid: 42, ppid: 7, name: "my shell" },
  ]);
});

// Usefulness: verifies a hung ancestry read ends at its bound, names only the reason class, and
// ends the child, so `harness-check` cannot hang on a stuck process table (#729).
test.skipIf(!posix)(
  "readProcessTable ends a hung read at its bound and names no output",
  async () => {
    const error = await expectBoundKillsShim("ps", (timeoutMs) =>
      readProcessTable({ timeout: timeoutMs / 1000 }).catch((err) => err),
    );
    expect(error).toMatchObject({ name: "ProcessReadError", isCanceled: false });
    expect(error.reason).toMatch(/^timed out after /);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies the ancestry read has the same 30-second default bound as the command-line
// read, so a caller that sets none is still bounded (#729).
test.skipIf(!posix)("readProcessTable bounds the read at 30 seconds by default", async () => {
  await useShim("echo '1 0 init'");
  await readProcessTable();
  expect(vi.mocked(exec).mock.lastCall[2]).toMatchObject({ timeout: 30 });
});

// Usefulness: verifies a cancel signal reaches the process-table reader that `nearestHarness` uses.
test("nearestHarness passes its cancel signal to the reader", async () => {
  const controller = new AbortController();
  let received;
  await nearestHarness({
    startPid: 5,
    signal: controller.signal,
    readProcesses: async (options) => {
      received = options;
      return [];
    },
  });
  expect(received.signal).toBe(controller.signal);
});
