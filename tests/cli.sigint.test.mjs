import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vite-plus/test";

const redaction = vi.hoisted(() => ({ throwOnRedact: false }));
vi.mock("../src/lib/test-cmd.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    redactCommandText: (command) => {
      if (redaction.throwOnRedact) throw new Error("redaction failed");
      return real.redactCommandText(command);
    },
  };
});

import { main } from "../src/cli.mjs";
import { createTempRepo, removePath, within } from "./runtime-helpers.mjs";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const ARGS = ["--orchestrator", "codex", "--worker", "claude", "--reviewer", "agy", "--task", "t"];

// Usefulness: acceptance (#669) — an exception between the listener registration and the run loop
// leaves no SIGINT listener behind, so no later run or caller inherits a stale handler.
test("an exception before the run loop removes the SIGINT listener", async () => {
  const repo = await createTempRepo();
  const before = process.listenerCount("SIGINT");
  redaction.throwOnRedact = true;
  try {
    await expect(main([...ARGS, "--cwd", repo, "--test-cmd", "echo ok"], {})).rejects.toThrow(
      "redaction failed",
    );
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally {
    redaction.throwOnRedact = false;
    await removePath(repo);
  }
});

// Usefulness: acceptance (#669) — a second real SIGINT ends a run whose cancel does not finish
// (an adapter that ignores the signal) with exit 130. Windows has no signals, so the case cannot
// run there.
test.skipIf(process.platform === "win32")(
  "a second real SIGINT ends a run that ignores the first with exit 130",
  async () => {
    const repo = await createTempRepo();
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
      "const stall = { async run() {",
      '  console.log("ready");',
      "  await new Promise(() => setInterval(() => {}, 1000));",
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { codex: stall, claude: ok, agy: ok });",
    ].join("\n");
    let child;
    try {
      child = spawn(
        process.execPath,
        ["--input-type=module", "-e", runner, "--", ...ARGS, "--cwd", repo],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await within(
        new Promise((resolve) =>
          child.stdout.on("data", (chunk) => /ready/.test(chunk) && resolve()),
        ),
        20_000,
        "The stalled turn start",
      );
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(child.exitCode).toBeNull();
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 20_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
    }
  },
  60_000,
);
