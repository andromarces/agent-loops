import { expect, test, vi } from "vite-plus/test";

// Caller-set value that the mocked `readFile` throws; `unset` passes through to the real one.
const control = vi.hoisted(() => ({ thrown: { value: undefined, active: false } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn(async (...args) => {
      if (control.thrown.active) {
        throw control.thrown.value;
      }
      return actual.readFile(...args);
    }),
  };
});

import { readTaskFile } from "../../src/lib/args.mjs";
import { readContinuation } from "../../src/lib/continuation.mjs";

const hostile = {
  get message() {
    throw new Error("getter");
  },
};

function throwOnRead(value) {
  control.thrown = { value, active: true };
}

// Usefulness: acceptance (#490) — a read failure that is `null`, `undefined`, or has a throwing
// `message` getter still ends in the documented read error, with the original as its cause.
test.each([
  ["null", null],
  ["undefined", undefined],
  ["a throwing message getter", hostile],
])("readTaskFile and readContinuation report a read failure that throws %s", async (_n, thrown) => {
  throwOnRead(thrown);
  try {
    await expect(readTaskFile("task.md", async () => "")).rejects.toThrow(
      "Cannot read --task-file task.md:",
    );
    await expect(readContinuation("run.json")).rejects.toThrow(
      "--continue-from cannot read run.json:",
    );
  } finally {
    control.thrown = { value: undefined, active: false };
  }
});

// Usefulness: acceptance (#490) — an ordinary read failure keeps its code or message in the text.
test("readTaskFile and readContinuation keep the message of an ordinary read failure", async () => {
  const missing = "no-such-490-file.json";
  await expect(readTaskFile(missing, async () => "")).rejects.toThrow("ENOENT");
  await expect(readContinuation(missing)).rejects.toThrow(/cannot read .*: ENOENT/);
});
