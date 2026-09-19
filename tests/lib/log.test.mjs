import { afterEach, expect, test, vi } from "vitest";
import { logDebug, logError, logInfo, logWarn, setVerbose } from "../../src/lib/log.mjs";

afterEach(() => {
  setVerbose(false);
  vi.restoreAllMocks();
});

// Usefulness: verifies issue #26 constraint mapping — info goes to stdout, warn and error to stderr.
test("logInfo logs to stdout and logWarn and logError log to stderr", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  logInfo("started");
  logWarn("recovered");
  logError("failed");

  expect(logSpy).toHaveBeenCalledWith("[agent-loop] started");
  expect(errorSpy).toHaveBeenCalledWith("[agent-loop] recovered");
  expect(errorSpy).toHaveBeenCalledWith("[agent-loop] failed");
});

// Usefulness: verifies the debug gate — debug lines are suppressed by default and shown with --verbose.
test("logDebug is gated behind setVerbose", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  logDebug("hidden");
  expect(logSpy).not.toHaveBeenCalled();

  setVerbose(true);
  logDebug("shown");
  expect(logSpy).toHaveBeenCalledWith("[agent-loop] shown");
});
