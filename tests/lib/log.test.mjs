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

// Usefulness: verifies warn and error lines are length-bounded (an error keeps its final sentence, up to its last 200
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
    `[agent-loop] error: ${"x".repeat(100)}...${"x".repeat(200)}`,
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

const ERROR_PREFIX = "[agent-loop] error: ";

function loggedError(message) {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logError(message);
  return errorSpy.mock.calls.at(-1)[0].slice(ERROR_PREFIX.length);
}

// Usefulness: verifies #515 review blocker 1 — a cut never splits a surrogate pair, so the log
// line stays well-formed Unicode. A one-sentence message cuts after 100 head characters and
// before the last 200, so the sweeps put the pair across each of those two cuts.
test("a cut never splits a surrogate pair", () => {
  for (let head = 97; head <= 103; head++) {
    expect(loggedError(`${"x".repeat(head)}😀${"y".repeat(400)}`).isWellFormed()).toBe(true);
  }
  for (let rest = 196; rest <= 202; rest++) {
    expect(loggedError(`${"x".repeat(400)}😀${"y".repeat(rest)}`).isWellFormed()).toBe(true);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  logInfo(`${"x".repeat(299)}😀${"y".repeat(5)}`);
  expect(console.log.mock.calls.at(-1)[0].isWellFormed()).toBe(true);
});

// Whole markers removed, a line holds no fragment of one and no secret value.
function expectOnlyWholeMarkers(line, name) {
  const rest = line.split(`[redacted:${name}]`).join("");
  expect(rest).not.toContain("redacted:");
  expect(rest).not.toContain("AGENT_TEST");
  expect(line).not.toContain("s3cr3t");
}

// Usefulness: verifies #515 review blockers 2 and 1 of the second review — a cut never lands
// inside a redaction marker, wherever the marker sits and whatever characters (including `]`)
// the variable name holds. The sweeps put the marker across the head cut and the tail cut.
test.each(["AGENT_TEST_SECRET", "AGENT_TEST_SECRET]X"])(
  "a cut never splits a redaction marker for variable %s",
  (name) => {
    vi.stubEnv(name, "s3cr3t-value-123");
    for (let offset = 60; offset <= 105; offset++) {
      expectOnlyWholeMarkers(
        loggedError(`${"x".repeat(offset)}s3cr3t-value-123${"y".repeat(400)}`),
        name,
      );
    }
    for (let rest = 150; rest <= 235; rest++) {
      expectOnlyWholeMarkers(
        loggedError(`${"x".repeat(400)}s3cr3t-value-123${"y".repeat(rest)}`),
        name,
      );
    }
  },
);

// Usefulness: verifies #515 second-review blocker 2 — trailing whitespace does not count against
// the final-sentence budget, so a short final instruction is not erased by a trailing newline run.
test("trailing whitespace does not erase the final instruction", () => {
  const instruction = "Remove the directory manually.";
  const line = loggedError(
    `Install directory ${"/long".repeat(80)} failed. ${instruction}${"\n".repeat(250)}`,
  );
  expect(line.endsWith(instruction)).toBe(true);
});

// Usefulness: verifies #515 review blocker 3 — the whole final sentence survives when it is up
// to 200 characters, even past 100, and the line stays bounded when it is longer.
test("logError keeps the whole final sentence up to 200 characters", () => {
  const path = "/long".repeat(80);
  const instruction = `The manifest was already deleted. ${"Remove the directory by hand ".repeat(5)}now.`;
  expect(instruction.length).toBeGreaterThan(100);
  const line = loggedError(
    `Install directory ${path} could not be removed (EPERM). ${instruction}`,
  );
  expect(line.endsWith(instruction.slice(instruction.indexOf("Remove")))).toBe(true);
  expect(line.startsWith("Install directory /long")).toBe(true);
  expect(line.length).toBeLessThanOrEqual(303);

  const huge = `${"Do this ".repeat(60)}now.`;
  const bounded = loggedError(`Failed at ${path}. ${huge}`);
  expect(bounded.length).toBeLessThanOrEqual(303);
  expect(bounded.endsWith("now.")).toBe(true);
});
