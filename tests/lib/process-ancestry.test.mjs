import { expect, test } from "vitest";
import { harnessForProcessName, nearestHarness } from "../../src/lib/process-ancestry.mjs";

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
