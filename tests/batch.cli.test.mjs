import { expect, test, vi } from "vite-plus/test";
import { runBatchMain } from "../src/batch/cli.mjs";
import { setLogsToStderr } from "../src/lib/log.mjs";

async function runQuiet(argv) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runBatchMain(argv);
    return {
      code,
      out: log.mock.calls.map((call) => call.join(" ")).join("\n"),
      err: error.mock.calls,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    setLogsToStderr(false);
  }
}

// Usefulness: a refused start exits 2 before any state write or child.
test("a refused start exits 2", async () => {
  const { code, out } = await runQuiet(["start", "--issue", "1"]);
  expect(code).toBe(2);
  expect(out).toBe("");
});

// Usefulness: a status read of an unknown batch is a usage refusal, not a crash.
test("status of an unknown batch exits 2", async () => {
  const { code } = await runQuiet(["status", "--batch", "no-such-batch"]);
  expect(code).toBe(2);
});

// Usefulness: resume requires the batch id.
test("resume without --batch exits 2", async () => {
  const { code } = await runQuiet(["resume"]);
  expect(code).toBe(2);
});

// Usefulness: an unknown batch command is refused.
test("an unknown batch command exits 2", async () => {
  const { code } = await runQuiet(["wat"]);
  expect(code).toBe(2);
});

// Usefulness: batch help prints the command surface.
test("batch help prints the commands and exit codes", async () => {
  const { code, out } = await runQuiet(["--help"]);
  expect(code).toBe(0);
  expect(out).toContain("agent-loop batch start");
  expect(out).toContain("130");
});
