import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see `withContinueRepo`). Every other
// test, and every other command, reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer && command === "git"
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

const redaction = vi.hoisted(() => ({ throwOnRedact: false }));
vi.mock("../src/lib/redact.mjs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    redactAndClean: (command) => {
      if (redaction.throwOnRedact) throw new Error("redaction failed");
      return real.redactAndClean(command);
    },
  };
});

import { main } from "../src/cli.mjs";
import {
  cleanRepoGit,
  createWithContinueRepo,
  createTempRepo,
  processExists,
  removePath,
  within,
} from "./runtime-helpers.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

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

const withContinueRepo = createWithContinueRepo(gitDouble);

// Usefulness: verifies SIGINT cancel through cli.mjs sets exitCode 130 and writes transcript.
test("SIGINT cancel through cli.mjs exits 130 and records transcript", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const fakeAgents = {
    codex: {
      async run() {
        process.emit("SIGINT");
        // Simulate execa cancel behavior on signal
        const err = new Error("canceled");
        err.isCanceled = true;
        throw err;
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };

  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      fakeAgents,
    );

    expect(process.exitCode).toBe(130);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(130);
    expect(transcript.error).toContain("Interrupted by SIGINT");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: verifies a headless reviewer turn whose evidence snapshot a second SIGINT ended keeps
// the "not captured" reason in the error report and the transcript. The cancel never reads as a
// plain interrupt (#729).
test("a headless reviewer cancel in the evidence snapshot reports the evidence as not captured", async () => {
  await withContinueRepo(async (repo, transcriptPath, errorSpy) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    let armed = false;
    let fired = false;
    gitDouble.answer = (command, args, options) => {
      if (armed && !fired && args[1] === "--show-toplevel") {
        fired = true;
        process.emit("SIGINT");
        process.emit("SIGINT");
      }
      return options?.cancelSignal?.aborted
        ? { exitCode: undefined, isCanceled: true, stdout: "", stderr: "" }
        : cleanRepoGit(command, args, options);
    };
    const agents = {
      codex: {
        async run() {
          return JSON.stringify({ action: "run_reviewer", prompt: "check" });
        },
      },
      claude: {
        async run() {
          return "worker ok";
        },
      },
      agy: {
        async run() {
          armed = true;
          return "reviewer ok";
        },
      },
    };
    try {
      await main(
        [
          "--orchestrator",
          "codex",
          "--worker",
          "claude",
          "--reviewer",
          "agy",
          "--task",
          "task",
          "--cwd",
          repo,
          "--transcript",
          transcriptPath,
        ],
        agents,
      );
      expect(fired).toBe(true);
      expect(process.exitCode).toBe(130);
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      expect(transcript.exitCode).toBe(130);
      expect(transcript.error).toMatch(/Interrupted by SIGINT.*not captured/);
      expect(errorSpy.mock.calls.flat().join("\n")).toMatch(/not captured/);
    } finally {
      exit.mockRestore();
    }
  });
});

// Usefulness: verifies a canceled snapshot error whose message cannot convert to text still ends
// the run with exit 130 and a written transcript. A hostile reason never escapes the cancel path
// (#729).
test("a cancel whose snapshot reason cannot convert to text still exits 130", async () => {
  const repo = await createTempRepo();
  const transcriptPath = join(repo, "transcript.json");
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const hostile = new Error("placeholder");
  hostile.name = "SnapshotError";
  hostile.isCanceled = true;
  Object.defineProperty(hostile, "message", {
    get() {
      return {
        toJSON() {
          throw new Error("no JSON");
        },
        toString() {
          throw new Error("no text");
        },
      };
    },
  });
  const agents = {
    codex: {
      async run() {
        throw hostile;
      },
    },
    claude: {
      async run() {
        return "worker ok";
      },
    },
    agy: {
      async run() {
        return "reviewer ok";
      },
    },
  };
  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "task",
        "--cwd",
        repo,
        "--transcript",
        transcriptPath,
      ],
      agents,
    );
    expect(process.exitCode).toBe(130);
    const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
    expect(transcript.exitCode).toBe(130);
    expect(transcript.error).toContain("Interrupted by SIGINT");
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});

// Usefulness: acceptance (#669). A real SIGINT while an execa child runs ends the run through its
// handler (exit 130, transcript written), not by a re-raised signal. A child process is needed,
// because the execa exit handler re-raises the signal only when no other SIGINT listener remains.
// Windows has no signals, so `kill("SIGINT")` ends the process there at once and the case cannot
// run.
test.skipIf(process.platform === "win32")(
  "a real SIGINT during a child turn exits 130 and writes the transcript",
  async () => {
    const repo = await createTempRepo();
    const transcriptPath = join(repo, "transcript.json");
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
      `import { exec } from ${JSON.stringify(pathToFileURL(CLI.replace("cli.mjs", "lib/exec.mjs")).href)};`,
      "const stall = { async run(_state, _prompt, { signal }) {",
      '  console.log("ready");',
      '  await exec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal });',
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { codex: stall, claude: ok, agy: ok });",
    ].join("\n");
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          "--",
          "--orchestrator",
          "codex",
          "--worker",
          "claude",
          "--reviewer",
          "agy",
          "--task",
          "task",
          "--cwd",
          repo,
          "--transcript",
          transcriptPath,
        ],
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
      const { code, signal } = await within(exited, 20_000, "The CLI exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
      expect(transcript.exitCode).toBe(130);
      expect(transcript.error).toContain("Interrupted by SIGINT");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
    }
  },
  60_000,
);

// Usefulness: acceptance (#669). The SIGINT listener stays registered while the run handles the
// first signal. The exit handler of execa then finds another listener and does not re-raise the
// signal. This holds on every platform, unlike the real-signal case above.
test("the SIGINT listener of a run stays registered after the signal fires", async () => {
  const repo = await createTempRepo();
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = process.listenerCount("SIGINT");
  let during;
  const fakeAgents = {
    codex: {
      async run() {
        process.emit("SIGINT");
        during = process.listenerCount("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
    },
    claude: {
      async run() {
        return "ok";
      },
    },
    agy: {
      async run() {
        return "ok";
      },
    },
  };
  try {
    await main(
      [
        "--orchestrator",
        "codex",
        "--worker",
        "claude",
        "--reviewer",
        "agy",
        "--task",
        "t",
        "--cwd",
        repo,
      ],
      fakeAgents,
    );
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally {
    process.exitCode = origExitCode;
    errorSpy.mockRestore();
    await removePath(repo);
  }
});
