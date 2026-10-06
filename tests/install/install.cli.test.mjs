import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { main as cliMain } from "../../src/cli.mjs";
import { HARNESS_MISMATCH_EXIT, runHarnessCheckCommand } from "../../src/install/commands.mjs";
import { restoreAgentLoopHome } from "../runtime-helpers.mjs";
import { makeHome, cleanupHomes } from "./install-helpers.mjs";

afterEach(cleanupHomes);

// Usefulness: verifies the CLI wiring — `install --dry-run` returns success
// without writing, and `harness-check` fails before any harness table is read
// for an unknown or missing harness name.
test("CLI dispatches install, uninstall, and harness-check", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness", "claude", "--yes", "--dry-run"]);
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);

    process.exitCode = 0;
    await cliMain(["uninstall", "--yes"]);
    expect(process.exitCode).toBe(0);

    process.exitCode = 0;
    await cliMain(["harness-check", "not-a-harness"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await cliMain(["harness-check"]);
    expect(process.exitCode).toBe(1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#210) — install and uninstall accept the
// inline `--harness=<list>` form.
test("CLI install and uninstall accept --harness=<list>", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness=claude,codex", "--yes"]);
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);

    process.exitCode = 0;
    await cliMain(["uninstall", "--harness=claude,codex", "--yes"]);
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#210) — the install parser rejects an inline
// value on a boolean flag with a clear error instead of ignoring it.
test("CLI install rejects --verbose=1", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const errors = [];
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => errors.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["install", "--verbose=1", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--verbose does not take a value.");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#186) — install and uninstall print their own
// usage for --help and -h and exit 0. Verifies acceptance (#419) — usage goes to
// stdout only; the stderr-empty check is not redundant because the stdout
// assertion alone passes when usage is also written to stderr.
test.each([
  ["install", "--help", "Usage: agent-loop install [--harness <list>] [--yes] [--dry-run]"],
  ["install", "-h", "Usage: agent-loop install [--harness <list>] [--yes] [--dry-run]"],
  ["uninstall", "--help", "Usage: agent-loop uninstall [--harness <list>] [--yes] [--dry-run]"],
  ["uninstall", "-h", "Usage: agent-loop uninstall [--harness <list>] [--yes] [--dry-run]"],
])("CLI %s %s prints usage to stdout only and exits 0", async (command, flag, usage) => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  const errors = [];
  console.log = (message) => lines.push(String(message));
  console.error = (message) => errors.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain([command, flag]);
    expect(process.exitCode).toBe(0);
    expect(lines.join("\n")).toContain(usage);
    expect(errors).toEqual([]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#186) — an unknown flag exits 1 with an
// error. Verifies acceptance (#419) — the error goes to stderr only; the
// stdout-empty check is not redundant because the stderr assertion alone passes
// when the error is also written to stdout.
test.each(["install", "uninstall"])(
  "CLI %s rejects an unknown flag on stderr only",
  async (command) => {
    const originalLog = console.log;
    const originalError = console.error;
    const lines = [];
    const errors = [];
    console.log = (message) => lines.push(String(message));
    console.error = (message) => errors.push(String(message));
    try {
      process.exitCode = 0;
      await cliMain([command, "--nope"]);
      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toContain("Unknown argument: --nope");
      expect(lines).toEqual([]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exitCode = 0;
    }
  },
);

// Usefulness: verifies acceptance (#215) — the install parser rejects an inline
// value on any boolean flag, empty or not, without a hand-maintained list.
test("CLI install rejects an inline value on a boolean flag", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const errors = [];
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => errors.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["install", "--dry-run=1", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--dry-run does not take a value.");

    errors.length = 0;
    process.exitCode = 0;
    await cliMain(["install", "--yes="]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--yes does not take a value.");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#215) — an unknown inline argument keeps the
// `=value` segment in the error, so the whole token the user typed is reported.
test("CLI install reports the full unknown inline token", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const errors = [];
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => errors.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["install", "--nope=bar", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Unknown argument: --nope=bar");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance (#210) — the inline form rejects an empty
// value at parse time, so `--harness=` cannot act as a silent no-op.
test("CLI install rejects --harness=", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const originalLog = console.log;
  const errors = [];
  const originalError = console.error;
  console.log = () => {};
  console.error = (message) => errors.push(String(message));
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness=", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Missing value for --harness.");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies the #151 exit-code contract — a harness mismatch exits
// with its own code (3), a match exits 0, and a check that cannot read the
// ancestry exits 1, so a skill can separate a refusal from a check that cannot
// run.
test("harness-check separates a harness mismatch from a check that cannot run", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    process.exitCode = 0;
    await runHarnessCheckCommand(["claude"], { lookup: async () => "claude" });
    expect(process.exitCode).toBe(0);

    process.exitCode = 0;
    await runHarnessCheckCommand(["claude"], { lookup: async () => "codex" });
    expect(process.exitCode).toBe(HARNESS_MISMATCH_EXIT);
    expect(HARNESS_MISMATCH_EXIT).not.toBe(1);

    process.exitCode = 0;
    await runHarnessCheckCommand(["claude"], { lookup: async () => null });
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await runHarnessCheckCommand(["claude"], {
      lookup: async () => {
        throw new Error("no process table");
      },
    });
    expect(process.exitCode).toBe(1);
  } finally {
    console.error = originalError;
    process.exitCode = 0;
  }
});

// Usefulness: verifies the acceptance text "Print the manual snippet instead" —
// the CLI prints the snippet on stdout when a settings file does not parse, so
// the maintainer can add the guard by hand.
test("CLI prints the manual snippet when a settings file does not parse", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;
  const settingsPath = join(home, ".claude", "settings.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, "{ bad\n", "utf8");

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => logs.push(String(message));
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness", "claude", "--yes"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("hooks.PreToolUse");
    expect(existsSync(join(home, ".claude", "skills", "agent-loop", "SKILL.md"))).toBe(false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: verifies acceptance #200 — a post-install note longer than the
// 300-character log cap prints in full, so its final sentence (that the skill
// stops when the check cannot run or finds no harness ancestor) reaches the user.
test("CLI prints a post-install note past the log cap in full", async () => {
  const home = await makeHome();
  process.env.AGENT_LOOP_HOME = home;

  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => logs.push(String(message));
  console.error = () => {};
  try {
    process.exitCode = 0;
    await cliMain(["install", "--harness", "codex", "--yes"]);
    expect(process.exitCode).toBe(0);
    // Isolate the Codex note line: a truncated one drops its final sentence.
    const note = logs.find((line) => line.includes("The Codex skill lives in the shared"));
    expect(note).toBeDefined();
    expect(note.endsWith("finds no harness ancestor.")).toBe(true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});
