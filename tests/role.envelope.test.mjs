import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";
import { executeRoleCommand, main as runRoleMain } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  settleStreamEvents,
  spyStdoutWrite,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

afterEach(cleanup);

// Usefulness: verifies acceptance — stdout holds exactly one JSON object on
// every path, including errors (verified through the main entry point).
test("main prints exactly one JSON object on stdout on success and error paths", async () => {
  const repo = await newRunRepo();
  const logSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    await runRoleMain(
      [
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
        agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      },
    );
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ status: "ok", role: "worker" });

    logSpy.mockClear();
    await runRoleMain(["dispatch", "--cwd", repo], { agents: {} });
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
      status: "error",
      error: expect.stringContaining("dispatch requires --role"),
    });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies an error whose message cannot be read still yields one JSON envelope
// through main, and that a cancel raised while reading it keeps exit 130 (SIGINT during the read).
test.each([
  [true, 130],
  [false, 1],
])(
  "main prints one error envelope when the message getter throws (isCanceled=%s, exit %i)",
  async (isCanceled, exitCode) => {
    const repo = await newRunRepo();
    const logSpy = spyStdoutWrite();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const origExitCode = process.exitCode;

    try {
      const promptFile = join(repo, "main-prompt.txt");
      await writeFile(promptFile, "work it", "utf8");
      const unreadable = {
        get message() {
          process.emit("SIGINT");
          throw Object.assign(new Error("message getter failed"), { isCanceled });
        },
      };
      const agents = {
        get fake1() {
          throw unreadable;
        },
        fake2: recordingAdapter([]),
      };
      await runRoleMain(
        [
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        { agents },
      );
      expect(logSpy.mock.calls.length).toBe(1);
      expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ status: "error" });
      expect(process.exitCode).toBe(exitCode);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = origExitCode;
    }
  },
);

// Usefulness: acceptance (#669) — the SIGINT listener of role main stays registered after the signal
// fires, so the execa exit handler finds another listener and does not re-raise it before the
// envelope prints.
test("the SIGINT listener of role main stays registered after the signal fires", async () => {
  const repo = await newRunRepo();
  const logSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;
  const before = process.listenerCount("SIGINT");
  let during;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        process.emit("SIGINT");
        during = process.listenerCount("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a thrown value whose message is not a string (BigInt, circular object,
// throwing toJSON) still yields one JSON error envelope through main instead of a stringify crash.
test.each([
  ["a BigInt", () => 10n, "10"],
  [
    "a circular object",
    () => {
      const loop = {};
      loop.self = loop;
      return loop;
    },
    "[unserializable message]",
  ],
  [
    "an object whose toJSON throws",
    () => ({
      toJSON() {
        throw new Error("toJSON failed");
      },
    }),
    "[unserializable message]",
  ],
  ["a function", () => () => {}, "[unserializable message]"],
  ["a Symbol", () => Symbol("message"), "[unserializable message]"],
  ["an object whose toJSON returns undefined", () => ({ toJSON() {} }), "[unserializable message]"],
  ["an object whose toJSON returns null", () => ({ toJSON: () => null }), null],
  ["NaN", () => Number.NaN, null],
  ["Infinity", () => Number.POSITIVE_INFINITY, null],
])("main prints one error envelope when the message is %s", async (_label, makeMessage, text) => {
  const repo = await newRunRepo();
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw { message: makeMessage() };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    expect(writeSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0])).toEqual({ status: "error", error: text });
    expect(process.exitCode).toBe(1);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a fatal child error whose message getter throws still ends the turn with a
// terminal lifecycle and a recorded turn, so the state file never keeps the dispatched lifecycle.
test("dispatch records the turn when reading the fatal error message throws", async () => {
  const repo = await newRunRepo();
  const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
  Object.defineProperty(fatal, "message", {
    get() {
      throw new Error("message getter failed");
    },
  });
  const agents = {
    fake1: {
      async run() {
        throw fatal;
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("halted");
  expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
  expect(state.lastResult).toMatchObject({ status: "error" });
});

// Usefulness: verifies requirement "a fatal turn records one result with the state and the
// event" (#1269): the ok path has a transcript test, and no other test reads the error path's event.
test("a fatal turn emits one result event that matches the recorded state", async () => {
  const repo = await newRunRepo();
  const transcriptPath = join(repo, "fatal-transcript.jsonl");
  const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
  const agents = {
    fake1: {
      async run() {
        throw fatal;
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--transcript", transcriptPath]), repo),
    { agents, stdin: stdinPrompt },
  );

  expect(result.exitCode).toBe(1);
  const events = (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const results = events.filter((event) => event.type === "result");
  expect(results).toHaveLength(1);
  const state = await readRepoState(repo);
  expect(results[0]).toMatchObject({ role: "worker", stepsUsed: state.stepsUsed });
  expect(results[0].result).toMatchObject({ role: "worker", status: "error" });
  expect(state.lifecycle).toBe("halted");
  expect(state.turns).toHaveLength(1);
  expect(state.lastResult.at).toBe(state.turns[0].at);
  expect(state.lastResult).toMatchObject({ role: "worker", status: "error" });
});

// Usefulness: verifies a fatal child error whose testRun getter throws still ends the turn with a
// terminal lifecycle and a recorded turn, so the state file never keeps the dispatched lifecycle.
test("dispatch records the turn when reading the fatal error testRun throws", async () => {
  const repo = await newRunRepo();
  const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
  Object.defineProperty(fatal, "testRun", {
    get() {
      throw new Error("testRun getter failed");
    },
  });
  const agents = {
    fake1: {
      async run() {
        throw fatal;
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("halted");
  expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
});

// Usefulness: verifies a child error whose name or timedOut getter throws returns an error result
// through the runtime, instead of the throw escaping the runtime catch block.
test.each(["name", "timedOut"])(
  "dispatch returns an error result when the child error %s getter throws",
  async (property) => {
    const repo = await newRunRepo();
    const failure = new Error("child failed");
    Object.defineProperty(failure, property, {
      get() {
        throw new Error(`${property} getter failed`);
      },
    });
    const agents = {
      fake1: {
        async run() {
          throw failure;
        },
      },
      fake2: recordingAdapter([]),
    };

    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      agents,
      stdin: stdinPrompt,
    });

    expect(result.payload).toMatchObject({
      role: "worker",
      status: "error",
      error: "child failed",
    });
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("active");
    expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
  },
);

// Usefulness: verifies a child error with a non-string message returns an error result through the
// runtime, instead of the TypeError that splitting the message raised.
test("dispatch returns an error result when a child error has a non-string message", async () => {
  const repo = await newRunRepo();
  const agents = {
    fake1: {
      async run() {
        throw { message: { code: 42 } };
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  expect(String(result.payload.error)).toContain("42");
});

// Usefulness: verifies a failed stdout write (callback error or a throw) is reported on stderr and
// in a non-zero exit code, so a lost envelope never looks like a clean exit 0.
test.each([
  ["through the write callback", false],
  ["by throwing", true],
])("main reports a failed stdout write %s", async (_label, throws) => {
  const repo = await newRunRepo();
  const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const writeSpy = spyStdoutWrite({ failure, throws });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    process.exitCode = 0;
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) } },
    );
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("EPIPE");
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a non-string message prints exactly as the base envelope printed it, under
// the key "error", so a toJSON that redacts by key still redacts and discloses nothing more.
test("main serializes a non-string message under the error key like the base envelope", async () => {
  const repo = await newRunRepo();
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw { message: { toJSON: (key) => (key === "error" ? "[redacted]" : "LEAKED-CONTENT") } };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).not.toContain("LEAKED-CONTENT");
    expect(JSON.parse(printed)).toEqual({ status: "error", error: "[redacted]" });
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a stateful toJSON is called once, so the envelope and the state file both
// hold the first (redacted) value and a later call cannot change what was printed or persisted.
test("main calls a message toJSON once and prints and persists the same value", async () => {
  const repo = await newRunRepo();
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    let calls = 0;
    const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
    Object.defineProperty(fatal, "message", {
      value: { toJSON: () => (++calls === 1 ? "[redacted]" : "LEAKED-CONTENT") },
    });
    const agents = {
      fake1: {
        async run() {
          throw fatal;
        },
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(printed)).toMatchObject({ status: "error", error: "[redacted]" });
    expect((await readRepoState(repo)).lastResult.error).toBe("[redacted]");
    expect(calls).toBe(1);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a stdout that errors asynchronously (closed pipe) leaves no unhandled
// stream error, and that a failed write keeps a cancel exit 130 rather than turning it into 1.
test.each([
  [true, 130],
  [false, 1],
])(
  "main consumes the stdout error event and keeps a non-zero exit code (isCanceled=%s, exit %i)",
  async (isCanceled, exitCode) => {
    const repo = await newRunRepo();
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const writeSpy = spyStdoutWrite({ failure, emitsErrorEvent: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const origExitCode = process.exitCode;

    try {
      const promptFile = join(repo, "main-prompt.txt");
      await writeFile(promptFile, "work it", "utf8");
      const agents = {
        get fake1() {
          throw {
            get message() {
              process.emit("SIGINT");
              throw Object.assign(new Error("message getter failed"), { isCanceled });
            },
          };
        },
        fake2: recordingAdapter([]),
      };
      await runRoleMain(
        [
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        { agents },
      );
      await settleStreamEvents();
      expect(writeSpy.unhandledErrorEvents).toBe(0);
      expect(process.exitCode).toBe(exitCode);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("EPIPE");
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = origExitCode;
    }
  },
);

// Usefulness: verifies coercing a non-string message never prints more than the base envelope
// did: a value that its toJSON redacts stays redacted, and its toString is never read.
test("main keeps a non-string message redacted by its toJSON", async () => {
  const repo = await newRunRepo();
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw {
          message: {
            toJSON: () => "[redacted]",
            toString: () => "SECRET-MARKER",
          },
        };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).not.toContain("SECRET-MARKER");
    expect(JSON.parse(printed)).toMatchObject({
      status: "error",
      error: expect.stringContaining("[redacted]"),
    });
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});
