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

import { readTaskFile } from "../../src/lib/args.mjs";

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
