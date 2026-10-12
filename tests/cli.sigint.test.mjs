import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import { createTempRepo, processExists, removePath, within } from "./runtime-helpers.mjs";

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
// (a child that ignores SIGTERM) with exit 130, leaves no child alive, and writes the transcript
// that the run holds. Windows has no signals, so the case cannot run there.
test.skipIf(process.platform === "win32")(
  "a second real SIGINT kills a SIGTERM-resistant child tree, writes the transcript, and exits 130",
  async () => {
    const repo = await createTempRepo();
    const transcriptPath = join(repo, "transcript.json");
    const scratch = await mkdtemp(join(tmpdir(), "cli-sigint-pids-"));
    const pidFile = join(scratch, "child.pid");
    const pidFiles = [pidFile, `${pidFile}.grand`];
    // The child records its pid, ignores SIGTERM, and starts a grandchild that does the same.
    const resistant =
      'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid));' +
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);' +
      'if (!process.argv[2]) require("child_process").spawn(process.execPath, ["-e", process.argv[3], process.argv[1] + ".grand", "grand", process.argv[3]], { stdio: "ignore" });';
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
      `import { exec } from ${JSON.stringify(pathToFileURL(CLI.replace("cli.mjs", "lib/exec.mjs")).href)};`,
      "const stall = { async run(_state, _prompt, { signal }) {",
      `  await exec(process.execPath, ["-e", ${JSON.stringify(resistant)}, ${JSON.stringify(pidFile)}, "", ${JSON.stringify(resistant)}], { signal });`,
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { codex: stall, claude: ok, agy: ok });",
    ].join("\n");
    let pids = [];
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          "--",
          ...ARGS,
          "--cwd",
          repo,
          "--transcript",
          transcriptPath,
        ],
        { stdio: "ignore" },
      );
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await vi.waitFor(
        async () => {
          const read = await Promise.all(
            pidFiles.map((file) => readFile(file, "utf8").then(Number, () => 0)),
          );
          expect(read.every((pid) => pid > 0)).toBe(true);
          pids = read;
        },
        { timeout: 20_000, interval: 100 },
      );
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The first SIGINT cancels the child with SIGTERM, which the tree ignores.
      expect(child.exitCode).toBeNull();
      expect(pids.every(processExists)).toBe(true);
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 20_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      // The force kill ends the tree well before the 5 s SIGKILL delay of execa.
      await vi.waitFor(() => expect(pids.some(processExists)).toBe(false), {
        timeout: 3000,
        interval: 100,
      });
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      expect(transcript.exitCode).toBe(130);
      expect(transcript.error).toContain("Interrupted by SIGINT");
    } finally {
      pids.forEach((pid) => processExists(pid) && process.kill(pid, "SIGKILL"));
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
      await removePath(scratch);
    }
  },
  60_000,
);

// Starts the CLI in a child process whose `git` or `ps` is a shell script that records its start and
// then hangs, sends one SIGINT after the record exists, and returns the exit code. A cancel that
// reaches the hung read ends the CLI with 130 well before the script ends by itself at 30 s.
async function exitCodeOfCanceledHangingRead({ argv, script, shimName, cwd }) {
  const scratch = await mkdtemp(join(tmpdir(), "cli-hang-shim-"));
  const marker = join(scratch, "started");
  const shim = join(scratch, shimName);
  await writeFile(shim, `#!/bin/sh\n${script.replaceAll("__MARKER__", marker)}\n`);
  await chmod(shim, 0o755);
  const runner = [
    `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
    "const ok = { async run() { return 'ok'; } };",
    `await main(${JSON.stringify(argv)}.concat(process.argv.slice(1)), { codex: ok, claude: ok, agy: ok });`,
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", runner, "--", ...cwd], {
    stdio: "ignore",
    env: { ...process.env, PATH: `${scratch}${delimiter}${process.env.PATH}` },
  });
  try {
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    await vi.waitFor(async () => expect(await readFile(marker, "utf8")).toBe("started\n"), {
      timeout: 20_000,
      interval: 100,
    });
    child.kill("SIGINT");
    return await within(exited, 15_000, "The CLI exit");
  } finally {
    child.kill("SIGKILL");
    await removePath(scratch);
  }
}

// Usefulness: verifies the first SIGINT ends a run whose `--cwd` validation hangs with exit 130,
// so the validation is bounded by the cancel and not only by its own end (#729).
test.skipIf(process.platform === "win32")(
  "a SIGINT during the --cwd validation ends the run with exit 130",
  async () => {
    const repo = await createTempRepo();
    try {
      const code = await exitCodeOfCanceledHangingRead({
        argv: [...ARGS],
        shimName: "git",
        script: 'echo started > "__MARKER__"\nexec sleep 30',
        cwd: ["--cwd", repo],
      });
      expect(code).toBe(130);
    } finally {
      await removePath(repo);
    }
  },
  60_000,
);

// Usefulness: verifies the first SIGINT ends a run whose work-tree root read for the transcript
// location hangs, with exit 130, so that read honors the cancel (#729).
test.skipIf(process.platform === "win32")(
  "a SIGINT during the transcript location read ends the run with exit 130",
  async () => {
    const repo = await createTempRepo();
    try {
      const code = await exitCodeOfCanceledHangingRead({
        argv: [...ARGS],
        shimName: "git",
        script:
          'case "$*" in *--is-inside-work-tree*) echo true;; *) echo started > "__MARKER__"; exec sleep 30;; esac',
        cwd: ["--cwd", repo, "--transcript", join(repo, "transcript.json")],
      });
      expect(code).toBe(130);
    } finally {
      await removePath(repo);
    }
  },
  60_000,
);

// Usefulness: verifies the first SIGINT ends a hung `harness-check` process-table read with
// exit 130, so the command honors the cancel (#729).
test.skipIf(process.platform === "win32")(
  "a SIGINT during harness-check ends the process-table read with exit 130",
  async () => {
    const code = await exitCodeOfCanceledHangingRead({
      argv: ["harness-check", "claude"],
      shimName: "ps",
      script: 'echo started > "__MARKER__"\nexec sleep 30',
      cwd: [],
    });
    expect(code).toBe(130);
  },
  60_000,
);
