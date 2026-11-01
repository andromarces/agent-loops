import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `gitAbortingPostTurn` in git-helpers.mjs); every other test reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

// Replaces only `writeSync`, so a test can see the bytes that a forced exit writes to fd 1.
const fsDouble = vi.hoisted(() => ({ writeSync: null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    writeSync: (...args) => (fsDouble.writeSync ?? real.writeSync)(...args),
  };
});

import { executeRoleCommand, main } from "../src/role.mjs";
import { restoreRunsRoot } from "./env-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo, gitAbortingPostTurn } from "./git-helpers.mjs";
import { processExists } from "./process-helpers.mjs";
import { within } from "./wait-helpers.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  spyStdoutWrite,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";

import { createBarrierTest } from "./barrier-test.mjs";

// The moved dispatch cancel tests run through a body barrier (issue #943), so a body that
// outlasts its timeout cannot change `gitDouble.answer` while the next test runs.
const barrierTest = createBarrierTest();

const ROLE = fileURLToPath(new URL("../src/role.mjs", import.meta.url));
const EXEC = fileURLToPath(new URL("../src/lib/exec.mjs", import.meta.url));

// Usefulness: acceptance (#669) — a second real SIGINT during a role dispatch whose child ignores
// SIGTERM leaves no child alive, prints one cancel envelope, and exits 130. Windows has no
// signals, so the case cannot run there.
test.skipIf(process.platform === "win32")(
  "a second real SIGINT during a role dispatch kills the child, prints one envelope, and exits 130",
  async () => {
    const repo = await createTempRepo();
    const scratch = await mkdtemp(join(tmpdir(), "role-sigint-"));
    const pidFile = join(scratch, "child.pid");
    const promptFile = join(scratch, "prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const resistant =
      'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(ROLE).href)};`,
      `import { exec } from ${JSON.stringify(pathToFileURL(EXEC).href)};`,
      "const stall = { async run(_state, _prompt, { signal }) {",
      `  await exec(process.execPath, ["-e", ${JSON.stringify(resistant)}, ${JSON.stringify(pidFile)}], { signal });`,
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { agents: { fake1: stall, fake2: ok } });",
    ].join("\n");
    let pid;
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          "--",
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, AGENT_LOOP_RUNS_ROOT: scratch },
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 20_000, interval: 100 },
      );
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The first SIGINT cancels the child with SIGTERM, which it ignores.
      expect(child.exitCode).toBeNull();
      expect(processExists(pid)).toBe(true);
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 20_000, "The role exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      await vi.waitFor(() => expect(processExists(pid)).toBe(false), {
        timeout: 3000,
        interval: 100,
      });
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ status: "error" });
    } finally {
      if (pid && processExists(pid)) process.kill(pid, "SIGKILL");
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
      await removePath(scratch);
    }
  },
  60_000,
);

afterEach(async () => {
  fsDouble.writeSync = null;
  gitDouble.answer = null;
  restoreRunsRoot();
  await cleanup();
});

async function dispatchInProcess(agents) {
  const repo = await createTempRepo();
  const scratch = await mkdtemp(join(tmpdir(), "role-sigint-inproc-"));
  process.env.AGENT_LOOP_RUNS_ROOT = scratch;
  const promptFile = join(scratch, "prompt.txt");
  await writeFile(promptFile, "work it", "utf8");
  const argv = [
    "dispatch",
    "--role",
    "worker",
    "--cwd",
    repo,
    ...INIT_OVERRIDES,
    "--prompt-file",
    promptFile,
  ];
  return {
    run: () => main(argv, { agents }),
    cleanup: async () => {
      await removePath(repo);
      await removePath(scratch);
    },
  };
}

// Usefulness: acceptance (#669) — a second SIGINT that arrives while the normal envelope write is
// in flight neither adds a second envelope nor cuts the first: the exit waits for that write.
test("a second SIGINT during the normal envelope write waits for it and adds no envelope", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const forced = [];
  fsDouble.writeSync = (...args) => forced.push(args);
  const writes = [];
  let release;
  const stdout = spyStdoutWrite();
  stdout.mockImplementation((chunk, callback) => {
    writes.push(String(chunk));
    release = callback;
    process.emit("SIGINT");
    process.emit("SIGINT");
    return true;
  });
  const dispatch = await dispatchInProcess({
    fake1: recordingAdapter([]),
    fake2: recordingAdapter([]),
  });
  try {
    const running = dispatch.run();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 20_000 });
    expect(exit).not.toHaveBeenCalled();
    release(null);
    await running;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130), { timeout: 20_000 });
    expect(writes).toHaveLength(1);
    expect(forced).toHaveLength(0);
  } finally {
    stdout.mockRestore();
    errorSpy.mockRestore();
    exit.mockRestore();
    await dispatch.cleanup();
  }
});

// Usefulness: acceptance (#669) — a second SIGINT during a turn writes one complete cancel
// envelope through partial and EAGAIN writes, and the normal path then prints none, so stdout
// holds exactly one complete envelope.
test("a second SIGINT during a turn writes one complete envelope and the normal path prints none", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const bytes = [];
  let calls = 0;
  fsDouble.writeSync = (fd, buffer, offset = 0) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("try again"), { code: "EAGAIN" });
    expect(fd).toBe(1);
    bytes.push(...Buffer.from(buffer).subarray(offset, offset + 1));
    return 1;
  };
  const stdout = spyStdoutWrite();
  const dispatch = await dispatchInProcess({
    fake1: {
      async run() {
        process.emit("SIGINT");
        process.emit("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
    },
    fake2: recordingAdapter([]),
  });
  try {
    await dispatch.run();
    expect(exit).toHaveBeenCalledWith(130);
    expect(Buffer.from(bytes).toString("utf8")).toBe(
      `${JSON.stringify({ status: "error", error: "Interrupted by SIGINT" })}\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    stdout.mockRestore();
    errorSpy.mockRestore();
    exit.mockRestore();
    await dispatch.cleanup();
  }
});

// Usefulness: acceptance (#669) — a permanent write error after a partial write leaves the
// truncated envelope on stdout, logs the error, and still exits 130 (ADR 0033 decision 6).
test("a permanent error after a partial envelope write leaves it truncated, logs, and exits 130", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const bytes = [];
  let calls = 0;
  fsDouble.writeSync = (_fd, buffer, offset = 0) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    bytes.push(...Buffer.from(buffer).subarray(offset, offset + 1));
    return 1;
  };
  const stdout = spyStdoutWrite();
  const dispatch = await dispatchInProcess({
    fake1: {
      async run() {
        process.emit("SIGINT");
        process.emit("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
    },
    fake2: recordingAdapter([]),
  });
  try {
    await dispatch.run();
    expect(exit).toHaveBeenCalledWith(130);
    expect(Buffer.from(bytes).toString("utf8")).toBe("{");
    expect(stdout).not.toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/error: second SIGINT: the final write failed: ENOSPC/);
  } finally {
    stdout.mockRestore();
    errorSpy.mockRestore();
    exit.mockRestore();
    await dispatch.cleanup();
  }
});

// Usefulness: verifies a cancel that ends the turn after the CLI reported its session still
// persists the id for the resume that follows.
barrierTest("a canceled turn keeps the session id the CLI reported", async () => {
  const repo = await newRunRepo();
  const worker = {
    async run(state) {
      state.sessionId = "sess-canceled";
      throw Object.assign(new Error("canceled"), { isCanceled: true });
    },
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(130);
  expect((await readRepoState(repo)).roles.worker.sessionId).toBe("sess-canceled");
});

// Usefulness: verifies a cancel that lands after the CLI exits and before the adapter returns ends
// the turn interrupted with exit 130, not recorded ok with the run left active (#587).
barrierTest("a cancel after the child exits records the turn as canceled", async () => {
  const repo = await newRunRepo();
  const controller = new AbortController();
  const worker = recordingAdapter([
    () => {
      controller.abort();
      return REPORT;
    },
  ]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    signal: controller.signal,
  });

  expect(result.exitCode).toBe(130);
  expect(result.payload.status).toBe("error");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
});

// Usefulness: verifies a cancel that lands during the post-turn snapshot of a reviewer turn, after the
// adapter returned, ends the turn interrupted with exit 130 and records no ok result (#587).
barrierTest(
  "a cancel during the post-turn snapshot records the reviewer turn as canceled",
  async () => {
    const repo = await newRunRepo();
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
    const controller = new AbortController();
    const post = gitAbortingPostTurn(controller);
    gitDouble.answer = post.git;
    const reviewer = recordingAdapter([
      () => {
        post.arm();
        return REPORT;
      },
    ]);

    const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
      agents: { fake1: recordingAdapter([]), fake2: reviewer },
      stdin: stdinPrompt,
      signal: controller.signal,
    });

    expect(post.fired).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.payload.status).toBe("error");
    expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  },
);

// Usefulness: verifies ADR 0027 decision 5 for a replaced conversation: a canceled dispatch persists the
// id the CLI reported with the replaced mark, and the next worker dispatch sends the preamble (#587).
barrierTest(
  "a canceled dispatch persists the reported id and the next worker turn sends the preamble",
  async () => {
    const repo = await newRunRepo();
    await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    });
    const controller = new AbortController();
    const replaced = recordingAdapter([
      (state) => {
        state.sessionId = "replacement";
        state.conversationReplaced = true;
        controller.abort();
        return REPORT;
      },
    ]);

    const canceled = await executeRoleCommand(withRepo(dispatchArgv([]), repo), {
      agents: { fake1: replaced, fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
      signal: controller.signal,
    });
    expect(canceled.exitCode).toBe(130);
    expect((await readRepoState(repo)).roles.worker).toMatchObject({
      sessionId: "replacement",
      conversationReplaced: true,
    });

    const next = recordingAdapter([]);
    const result = await executeRoleCommand(
      withRepo(dispatchArgv(["--resume-interrupted"]), repo),
      {
        agents: { fake1: next, fake2: recordingAdapter([]) },
        stdin: stdinPrompt,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(next.recorded[0].incomingSessionId).toBe("replacement");
    expect(next.recorded[0].prompt).toContain("You are the implementation agent");
    expect((await readRepoState(repo)).roles.worker.conversationReplaced).toBeUndefined();
  },
);
