import { afterEach, expect, test, vi } from "vite-plus/test";
import { runHarnessCheckCommand } from "../../src/install/commands.mjs";
import { parseSettings } from "../../src/install/settings.mjs";

const hostile = {
  get message() {
    throw new Error("getter");
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

// Usefulness: acceptance (#490) — a process-table failure that is `null`, `undefined`, or has a
// throwing `message` getter still reaches the error log, and an ordinary Error keeps its message.
test.each([
  ["null", null, "null"],
  ["undefined", undefined, "undefined"],
  ["a throwing message getter", hostile, "could not read the process table"],
  ["an ordinary Error", new Error("table gone"), "table gone"],
])("harness-check reports a lookup failure that throws %s", async (_name, thrown, expected) => {
  const origExitCode = process.exitCode;
  const errors = [];
  vi.spyOn(console, "error").mockImplementation((text) => errors.push(String(text)));
  try {
    await runHarnessCheckCommand(["claude"], {
      lookup: async () => {
        throw thrown;
      },
    });
    expect(errors.join("\n")).toContain(expected);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = origExitCode;
  }
});

// Usefulness: acceptance (#490) — a settings parse failure with an unreadable message still
// throws the settings error that names the file, and an ordinary parse error keeps its message.
test("parseSettings names the file when the parse error has an unreadable message", () => {
  vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
    throw hostile;
  });
  expect(() => parseSettings("{}", "/home/settings.json")).toThrow(
    "Settings file does not parse: /home/settings.json",
  );
  expect(() => parseSettings("{nope", "/home/settings.json")).toThrow(
    /Settings file does not parse: \/home\/settings\.json \(.+\)/,
  );
});
