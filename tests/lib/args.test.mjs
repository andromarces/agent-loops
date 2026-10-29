import { expect, test, vi } from "vite-plus/test";

// Value that the mocked `readFile` throws while `active`; otherwise it reads the real file.
const readControl = vi.hoisted(() => ({ active: false, value: undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn(async (...args) => {
      if (readControl.active) {
        throw readControl.value;
      }
      return actual.readFile(...args);
    }),
  };
});

import {
  initRefusal,
  readStdinText,
  readTaskFile,
  STOP_FLAG_WALK,
  walkFlags,
} from "../../src/lib/args.mjs";

// Usefulness: acceptance (#490) — a read failure that is `null`, `undefined`, or has a throwing
// `message` getter still ends in the documented read error, so the catch block adds no second error.
test.each([
  ["null", null],
  ["undefined", undefined],
  [
    "a throwing message getter",
    {
      get message() {
        throw new Error("getter");
      },
    },
  ],
])("readTaskFile reports a read failure that throws %s", async (_name, thrown) => {
  readControl.active = true;
  readControl.value = thrown;
  try {
    await expect(readTaskFile("task.md", async () => "")).rejects.toThrow(
      "Cannot read --task-file task.md:",
    );
  } finally {
    readControl.active = false;
  }
});

// Usefulness: acceptance (#490) — an ordinary read failure keeps its error code in the text.
test("readTaskFile keeps the error code of an ordinary read failure", async () => {
  await expect(readTaskFile("no-such-490-file.md", async () => "")).rejects.toThrow("ENOENT");
});

// Usefulness: acceptance (#732) — a terminal stdin is refused with the caller's message, so `role` keeps its
// own wording, and with the task-file wording when the caller passes none.
test("readStdinText refuses a terminal with the message of the caller", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  try {
    await expect(readStdinText("custom tty message")).rejects.toThrow("custom tty message");
    await expect(readStdinText()).rejects.toThrow("--task-file - reads the task from stdin");
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      delete process.stdin.isTTY;
    }
  }
});

const validInit = {
  task: "Do it.",
  testCmd: null,
  testCmdTimeout: null,
  reviewerSandbox: null,
  pr: null,
  mode: null,
  worker: "claude",
  reviewer: "codex",
  workerModel: null,
  workerEffort: null,
  reviewerModel: null,
  reviewerEffort: null,
};
const initConfig = {
  roles: ["worker", "reviewer"],
  requiredRoles: ["worker", "reviewer"],
  isSupportedAgent: (kind) => ["claude", "codex", "opencode"].includes(kind),
  blankTaskText: "Task needed.",
  rolesFirst: false,
  pathRefusal: () => null,
};

// Usefulness: acceptance (#816) — each single fault yields its one refusal text for both paths, and
// a valid input yields none, so the shared composition is checked once instead of per path.
test.each([
  ["a valid input", {}, null],
  ["a blank task", { task: "  " }, "Task needed."],
  ["a blank test command", { testCmd: " " }, "--test-cmd must not be blank."],
  [
    "a sandbox on a non-Codex reviewer",
    { reviewer: "claude", reviewerSandbox: "read-only" },
    "--reviewer-sandbox requires --reviewer codex.",
  ],
  [
    "a PR in review-only",
    { mode: "review-only", pr: 5 },
    "--pr declares PR work, which needs the --require-ci gate; review-only rejects that gate.",
  ],
  ["a missing required role", { worker: null }, "Missing required --worker."],
  ["an unsupported agent", { worker: "nope" }, "Unsupported worker: nope"],
  [
    "an OpenCode effort without a model",
    { worker: "opencode", workerEffort: "high" },
    "--worker-effort requires --worker-model for opencode.",
  ],
])("initRefusal reports %s", (_name, change, expected) => {
  expect(initRefusal({ ...validInit, ...change }, initConfig)).toBe(expected);
});

// Usefulness: acceptance (#816) — a role that is optional but supplied with a model or an effort
// only is refused, and a null `blankTaskText` skips the task check for a task file.
test("initRefusal refuses an orphan model and skips the task check on request", () => {
  const optionalWorker = { ...initConfig, requiredRoles: ["reviewer"] };
  expect(initRefusal({ ...validInit, worker: null, workerModel: "m" }, optionalWorker)).toBe(
    "--worker-model requires --worker.",
  );
  expect(initRefusal({ ...validInit, task: null }, { ...initConfig, blankTaskText: null })).toBe(
    null,
  );
});

// Usefulness: acceptance (#1186) — walkFlags is the one flag loop, so its value, boolean, unknown
// and stop outcomes are what the CLI, role, and install parsers all inherit.
test("walkFlags hands each flag to its handler and enforces the value rules", () => {
  const seen = [];
  const onFlag = (arg, readInline) => {
    if (arg === "--name") {
      seen.push([arg, readInline(arg)]);
      return true;
    }
    if (arg === "--on") {
      seen.push([arg]);
      return true;
    }
    return false;
  };
  walkFlags(["skip", "--name", "a", "--name=b", "--on"], 1, onFlag);
  expect(seen).toEqual([["--name", "a"], ["--name", "b"], ["--on"]]);
  expect(() => walkFlags(["--on=1"], 0, onFlag)).toThrow("--on does not take a value.");
  expect(() => walkFlags(["--other=1"], 0, onFlag)).toThrow("Unknown argument: --other=1");
  expect(() => walkFlags(["--name"], 0, onFlag)).toThrow("Missing value for --name.");
});

// Usefulness: acceptance (#1186) — a handler that ends the walk still gets the inline-value
// refusal, which `--help=1` relies on, and the arguments after it stay unread.
test("walkFlags stops after a handler asks to and still refuses an inline value", () => {
  const onFlag = (arg) => (arg === "--help" ? STOP_FLAG_WALK : false);
  expect(() => walkFlags(["--help", "--bogus"], 0, onFlag)).not.toThrow();
  expect(() => walkFlags(["--help=1", "--bogus"], 0, onFlag)).toThrow(
    "--help does not take a value.",
  );
});
