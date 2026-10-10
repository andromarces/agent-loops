import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { exec } from "../../src/lib/exec.mjs";
import {
  harnessForProcessName,
  nearestHarness,
  readProcessCommands,
} from "../../src/lib/process-ancestry.mjs";
import { removePath, writePsShim } from "../runtime-helpers.mjs";

vi.mock("../../src/lib/exec.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, exec: vi.fn(real.exec) };
});

const SENTINEL = "SECRET-SENTINEL-4f9a1c";
const posix = process.platform !== "win32";
let shimDir;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (shimDir) {
    await removePath(shimDir);
    shimDir = undefined;
  }
});

async function useShim(body) {
  shimDir = await writePsShim(body);
  vi.stubEnv("PATH", `${shimDir}${delimiter}${process.env.PATH}`);
  return join(shimDir, "pid.txt");
}

// Runs `fn` and returns what it threw with everything the run printed.
async function failureAndOutput(fn) {
  const lines = [];
  for (const method of ["log", "error", "warn", "info"]) {
    vi.spyOn(console, method).mockImplementation((...args) => lines.push(args.join(" ")));
  }
  const error = await fn().catch((err) => err);
  return { error, printed: lines.join("\n") };
}

async function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Waits up to `ms` for the exact recorded pid to leave the process table.
async function gone(pid, ms = 3000) {
  for (let waited = 0; waited < ms && (await alive(pid)); waited += 50) {
    await delay(50);
  }
  return !(await alive(pid));
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

// Usefulness: verifies the process-table read has the 30-second default bound when the caller sets
// none. The real default, not an injected one, keeps a stalled `ps` from holding a run (#647).
test("readProcessCommands bounds the read at 30 seconds by default", async () => {
  await readProcessCommands();
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

// Usefulness: verifies the timeout and the cancel of a read that already wrote output name only
// the reason class, and that the read's process is gone after each, so it outlives neither.
test.skipIf(!posix)(
  "readProcessCommands names the timeout and ends the stalled process",
  async () => {
    const pidFile = await useShim(
      `echo $$ > __DIR__/pid.txt\necho ${SENTINEL}\necho ${SENTINEL} >&2\ntrap '' TERM\nwhile :; do sleep 1; done`,
    );
    const started = Date.now();
    const { error, printed } = await failureAndOutput(() => readProcessCommands({ timeout: 1 }));
    expect(error.reason).toBe("timed out after 1 seconds");
    expect(JSON.stringify([error.message, error.reason])).not.toContain(SENTINEL);
    expect(printed).not.toContain(SENTINEL);
    // A shell that ignores SIGTERM ends at the forced kill that follows the bound by 5 s.
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(await gone(Number(await readFile(pidFile, "utf8")))).toBe(true);
  },
  20_000,
);

test.skipIf(!posix)(
  "readProcessCommands names the cancel and ends the stalled process",
  async () => {
    const pidFile = await useShim(
      `echo $$ > __DIR__/pid.txt\necho ${SENTINEL}\necho ${SENTINEL} >&2\nexec sleep 30`,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const { error, printed } = await failureAndOutput(() =>
      readProcessCommands({ signal: controller.signal }),
    );
    expect(error).toMatchObject({ isCanceled: true, reason: "was canceled" });
    expect(JSON.stringify([error.message, error.reason])).not.toContain(SENTINEL);
    expect(printed).not.toContain(SENTINEL);
    expect(await gone(Number(await readFile(pidFile, "utf8")))).toBe(true);
  },
);
