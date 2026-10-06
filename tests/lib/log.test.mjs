import { afterEach, expect, test, vi } from "vite-plus/test";
import { logDebug, logError, logInfo, logWarn, setVerbose } from "../../src/lib/log.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
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

// Usefulness: verifies warn lines stay length-bounded, so model-controlled content
// (for example an unsupported-action echo in a repair warn) cannot flood a log line.
test("logWarn truncates messages beyond 300 characters", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  logWarn("x".repeat(400));

  expect(errorSpy).toHaveBeenCalledWith(`[agent-loop] warn: ${"x".repeat(300)}...`);
});

// Usefulness: verifies acceptance #515 — an error line keeps its full text, so a long path
// never hides the final instruction, and an env secret in that text is still redacted.
test("logError keeps the full message and redacts env secrets", () => {
  vi.stubEnv("AGENT_TEST_SECRET", "s3cr3t-value-123");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const message = `Install directory ${"/long".repeat(200)} s3cr3t-value-123 failed. Remove the directory manually.`;

  logError(message);

  expect(errorSpy).toHaveBeenCalledWith(
    `[agent-loop] error: ${message.replace("s3cr3t-value-123", "[redacted:AGENT_TEST_SECRET]")}`,
  );
});
