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

import { readStdinText, readTaskFile } from "../../src/lib/args.mjs";

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
