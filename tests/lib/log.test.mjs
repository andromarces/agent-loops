import { afterEach, expect, test, vi } from "vite-plus/test";
import { logDebug, logError, logInfo, logWarn, setVerbose } from "../../src/lib/log.mjs";

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
});

// Usefulness: verifies issue #26 levels are visible on the line, not only as a stream choice —
// info and debug go to stdout, warn and error go to stderr, each tagged with its level.
test("log lines are tagged with their level on the correct stream", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  logInfo("started");
  logWarn("recovered");
  logError("failed");

  expect(logSpy).toHaveBeenCalledWith("[agent-loop] info: started");
  expect(errorSpy).toHaveBeenCalledWith("[agent-loop] warn: recovered");
  expect(errorSpy).toHaveBeenCalledWith("[agent-loop] error: failed");
});

// Usefulness: verifies the debug gate — debug lines are suppressed by default and shown with --verbose,
// tagged debug so they stay distinguishable from info on stdout.
test("logDebug is gated behind setVerbose", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  logDebug("hidden");
  expect(logSpy).not.toHaveBeenCalled();

  setVerbose(true);
  logDebug("shown");
  expect(logSpy).toHaveBeenCalledWith("[agent-loop] debug: shown");
});

// Usefulness: verifies acceptance #200 — the 300-character cap still bounds an ordinary
// info line; only a post-install note is exempt through logInfoFull.
test("logInfo truncates messages beyond 300 characters", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const long = "x".repeat(400);

  logInfo(long);

  expect(logSpy).toHaveBeenCalledWith(`[agent-loop] info: ${"x".repeat(300)}...`);
});

// Usefulness: verifies warn and error lines are length-bounded (an error keeps its last 100
// characters, see #515), so model-controlled content
// (for example an unsupported-action echo in a repair warn) cannot flood a log line.
test("logWarn and logError truncate messages beyond 300 characters", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const long = "x".repeat(400);

  logWarn(long);
  logError(long);

  const truncated = `[agent-loop] warn: ${"x".repeat(300)}...`;
  expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
    truncated,
    `[agent-loop] error: ${"x".repeat(200)}...${"x".repeat(100)}`,
  ]);
});

// Usefulness: verifies acceptance #515 — an error whose long path pushes its final instruction
// past the cap still ends with that instruction, so the user sees the action to take. The cut
// falls in the middle and the line stays bounded.
test("logError keeps the final instruction of a message beyond 300 characters", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const message = `Install directory ${"/long".repeat(80)} could not be removed (EPERM). remove the directory manually.`;

  logError(message);

  const line = errorSpy.mock.calls[0][0];
  expect(line.startsWith("[agent-loop] error: Install directory /long")).toBe(true);
  expect(line.endsWith("remove the directory manually.")).toBe(true);
  expect(line.length).toBeLessThan("[agent-loop] error: ".length + 310);
});
