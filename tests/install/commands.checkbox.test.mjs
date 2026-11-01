import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";
import { runInstallCommand, runUninstallCommand } from "../../src/install/commands.mjs";
import { restoreAgentLoopHome } from "../env-helpers.mjs";
import { createBarrierTest } from "../barrier-test.mjs";
import { cleanupHomes, makeHome } from "./install-helpers.mjs";

const test = createBarrierTest();

// The numbered fallback prompt reads its answer from this stub instead of a
// terminal. The checkbox list never calls it. Each call records its options.
const prompt = vi.hoisted(() => ({ answer: "", failure: null, options: null }));
vi.mock("node:readline/promises", () => ({
  createInterface: (options) => {
    prompt.options = options;
    return {
      question: async () => {
        if (prompt.failure) {
          throw prompt.failure;
        }
        return prompt.answer;
      },
      close() {},
    };
  },
}));

class FakeInput extends EventEmitter {
  constructor({ isTTY = true, failRawMode = false, noRawMode = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.rawMode = false;
    if (!noRawMode) {
      this.setRawMode = (value) => {
        if (failRawMode) {
          throw new Error("no raw mode");
        }
        this.rawMode = value;
      };
    }
  }
}

class FakeOutput {
  constructor({ isTTY = true, failWhen = null, failCallbackFrom = null } = {}) {
    this.isTTY = isTTY;
    this.failWhen = failWhen;
    this.failCallbackFrom = failCallbackFrom;
    this.chunks = [];
    this.waiters = [];
  }

  write(text, callback) {
    if (this.failWhen?.(String(text), this.chunks.length)) {
      throw new Error("write failed");
    }
    this.chunks.push(String(text));
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.check(this.text)) {
        return true;
      }
      waiter.resolve();
      return false;
    });
    if (callback) {
      const index = this.chunks.length - 1;
      if (this.failCallbackFrom !== null && index >= this.failCallbackFrom) {
        queueMicrotask(() => callback(new Error("EIO")));
      } else {
        callback();
      }
    }
    return true;
  }

  get text() {
    return this.chunks.join("");
  }

  waitFor(check) {
    if (check(this.text)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push({ check, resolve }));
  }
}

afterEach(cleanupHomes);

/** Puts a runnable-looking CLI name on PATH, which is all detection checks. */
async function pathWith(...commands) {
  const directory = await makeHome();
  for (const command of commands) {
    await writeFile(join(directory, command), "", "utf8");
  }
  return directory;
}

function captureConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message) => logs.push(String(message));
  console.error = (message) => errors.push(String(message));
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

// Usefulness: acceptance #1319 — the install list marks and checks the detected
// harnesses, Space toggles another one, and Enter writes only the checked set.
test("install writes only the harnesses checked in the checkbox list", async () => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    const shown = output.text;
    expect(shown).toContain("> [x] Claude Code (claude) [detected]");
    expect(shown).toContain("  [ ] Codex CLI (codex)");
    expect(shown.indexOf("(claude)")).toBeLessThan(shown.indexOf("(antigravity)"));
    input.emit("keypress", "\x1b[B", { name: "down" });
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".opencode"))).toBe(false);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — confirming with no toggles installs the detected
// harnesses, the documented preselection contract.
test("install with no toggles installs the detected harnesses", async () => {
  const home = await makeHome();
  const path = await pathWith("codex");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — with no detected harness, Enter on the checked
// empty set prints the warning and exits 0 without writing.
test("install with nothing detected warns and writes nothing", async () => {
  const home = await makeHome();
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = home;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    expect(output.text).toContain("> [ ] Claude Code (claude)\n");
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(captured.errors.join("\n")).toContain("No harness selected; nothing to do.");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — unchecking every item and confirming prints the
// warning and exits 0 with no file write.
test("install unchecking every harness warns and writes nothing", async () => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(captured.errors.join("\n")).toContain("No harness selected; nothing to do.");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 and the README exit-code table — Ctrl+C exits 130
// and end of input keeps the base-branch exit 1. Neither writes a file.
test.each([
  ["Ctrl+C", (input) => input.emit("keypress", "\x03", { name: "c", ctrl: true }), 130],
  ["end of input", (input) => input.emit("end"), 1],
])("install %s exits %i and writes nothing", async (_name, cancel, expectedCode) => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    cancel(input);
    await run;
    expect(process.exitCode).toBe(expectedCode);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(input.rawMode).toBe(false);
    expect(output.text.endsWith("\x1b[?25h")).toBe(true);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — uninstall lists only installed harnesses, all
// checked, and removes only the checked ones.
test("uninstall lists the installed harnesses checked and removes only the checked", async () => {
  const home = await makeHome();
  const originalPath = process.env.PATH;
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = home;
  try {
    await runInstallCommand(["--harness", "claude,codex", "--yes"]);
    const output = new FakeOutput();
    const input = new FakeInput();
    process.exitCode = 0;
    const run = runUninstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    const shown = output.text;
    expect(shown).toContain("> [x] Claude Code (claude)");
    expect(shown).toContain("  [x] Codex CLI (codex)");
    expect(shown).not.toContain("OpenCode");
    expect(shown).not.toContain("[detected]");
    input.emit("keypress", "\x1b[B", { name: "down" });
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — unchecking every uninstall item warns, exits 0,
// and writes no file, the same outcome as install.
test("uninstall with every item unchecked warns and writes nothing", async () => {
  const home = await makeHome();
  const originalPath = process.env.PATH;
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = home;
  const settingsPath = join(home, ".claude", "settings.json");
  try {
    await runInstallCommand(["--harness", "claude", "--yes"]);
    const output = new FakeOutput();
    const input = new FakeInput();
    process.exitCode = 0;
    const run = runUninstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    input.emit("keypress", " ", { name: "space" });
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(captured.errors.join("\n")).toContain("No harness selected; nothing to do.");
    expect(captured.logs.join("\n")).not.toContain("Nothing to change.");
    expect(existsSync(settingsPath)).toBe(true);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — a terminal that cannot host the checkbox list
// runs the current numbered prompt with its current behavior.
test.each([
  ["TERM is dumb", { env: { TERM: "dumb" } }, { answer: "2", command: "codex" }],
  ["stdout is not a TTY", { output: { isTTY: false } }, { answer: "1", command: "claude" }],
  [
    "stdin cannot enter raw mode",
    { input: { failRawMode: true } },
    { answer: "1", command: "claude" },
  ],
  ["stdin has no raw mode", { input: { noRawMode: true } }, { answer: "1", command: "claude" }],
])("install falls back to the numbered prompt when %s", async (_name, streams, expected) => {
  const home = await makeHome();
  const path = await pathWith("claude", "codex");
  const originalPath = process.env.PATH;
  const output = new FakeOutput(streams.output);
  const input = new FakeInput(streams.input);
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  prompt.answer = expected.answer;
  try {
    process.exitCode = 0;
    await runInstallCommand([], { input, output, env: streams.env ?? { TERM: "xterm" } });
    expect(process.exitCode).toBe(0);
    expect(output.text).not.toContain("Select harnesses");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(expected.command === "claude");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(expected.command === "codex");
  } finally {
    prompt.answer = "";
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — when raw mode is unavailable, the numbered
// fallback must not retry raw mode through readline. It runs non-terminal and
// completes the selection.
test.each([
  ["setRawMode throws", { failRawMode: true }],
  ["setRawMode is missing", { noRawMode: true }],
])("the numbered fallback runs without raw mode when %s", async (_name, inputOptions) => {
  const home = await makeHome();
  const path = await pathWith("claude", "codex");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput(inputOptions);
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  prompt.answer = "2";
  prompt.options = null;
  try {
    process.exitCode = 0;
    await runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    expect(process.exitCode).toBe(0);
    expect(prompt.options.terminal).toBe(false);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  } finally {
    prompt.answer = "";
    prompt.options = null;
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — `--dry-run` on a TTY still shows the checkbox
// list, and the confirmed set writes nothing.
test("install --dry-run shows the checkbox list and writes nothing", async () => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput();
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand(["--dry-run"], {
      input,
      output,
      env: { TERM: "xterm-256color" },
    });
    await output.waitFor((text) => text.includes("Select harnesses"));
    expect(output.text).toContain("> [x] Claude Code (claude) [detected]");
    input.emit("keypress", "\r", { name: "return" });
    await run;
    expect(process.exitCode).toBe(0);
    expect(captured.logs.join("\n")).toContain("claude:");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — a prompt failure propagates unchanged instead
// of being read as a bad selection, and no file is written.
test("a checkbox prompt failure propagates unchanged", async () => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput({ failWhen: () => true });
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    await expect(
      runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } }),
    ).rejects.toThrow("write failed");
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(captured.errors).toEqual([]);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — an asynchronous cleanup write error rejects the
// install with the same error and writes no file.
test("an asynchronous cleanup write error rejects install and writes nothing", async () => {
  const home = await makeHome();
  const path = await pathWith("claude");
  const originalPath = process.env.PATH;
  const output = new FakeOutput({ failCallbackFrom: 2 });
  const input = new FakeInput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  process.env.PATH = path;
  try {
    process.exitCode = 0;
    const run = runInstallCommand([], { input, output, env: { TERM: "xterm-256color" } });
    await output.waitFor((text) => text.includes("Select harnesses"));
    input.emit("keypress", "\r", { name: "return" });
    await expect(run).rejects.toThrow("EIO");
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(input.rawMode).toBe(false);
    expect(input.listenerCount("keypress")).toBe(0);
  } finally {
    captured.restore();
    process.env.PATH = originalPath;
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — the non-interactive install refusal keeps its
// exact text and exit code 1 when no checkbox list runs.
test("install with a non-TTY stdin keeps the refusal", async () => {
  const home = await makeHome();
  const input = new FakeInput({ isTTY: false });
  const output = new FakeOutput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  try {
    process.exitCode = 0;
    await runInstallCommand([], { input, output, env: { TERM: "xterm" } });
    expect(process.exitCode).toBe(1);
    expect(captured.errors.join("\n")).toContain(
      "No --harness given and stdin is not interactive. Pass --harness <list>.",
    );
    expect(output.chunks).toEqual([]);
  } finally {
    captured.restore();
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});

// Usefulness: acceptance #1319 — a non-TTY uninstall keeps removing the
// manifest's harnesses without a prompt.
test("uninstall with a non-TTY stdin removes the manifest harnesses", async () => {
  const home = await makeHome();
  const input = new FakeInput({ isTTY: false });
  const output = new FakeOutput();
  const captured = captureConsole();
  process.env.AGENT_LOOP_HOME = home;
  try {
    process.env.PATH = home;
    await runInstallCommand(["--harness", "claude", "--yes"]);
    process.exitCode = 0;
    await runUninstallCommand([], { input, output, env: { TERM: "xterm" } });
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(output.chunks).toEqual([]);
  } finally {
    captured.restore();
    restoreAgentLoopHome();
    process.exitCode = 0;
  }
});
