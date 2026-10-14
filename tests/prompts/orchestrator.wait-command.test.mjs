import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { describe, expect, test, vi } from "vite-plus/test";
import { initialPrompt, waitChecksCommand } from "../../src/prompts/orchestrator.mjs";

const WAIT_PREFIX = 'role wait-checks --cwd "/work tree"';

const WAIT_COMMAND = [
  { shell: "PowerShell", command: `& "/opt/node" "/opt/agent-loops/src/cli.mjs" ${WAIT_PREFIX}` },
  { shell: "bash or cmd", command: `"/opt/node" "/opt/agent-loops/src/cli.mjs" ${WAIT_PREFIX}` },
];

const waitPrompt = (timeout, extra = {}) =>
  initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout,
    waitCommand: WAIT_COMMAND,
    ...extra,
  });

// Usefulness: verifies the headless wait runs through the runtime-owned command with a stated bound
// below the turn timeout (issue #348). It never runs through an unbounded `gh` watch, so a wait
// cannot end the run on the turn timeout.
test.each([
  [undefined, 300],
  [null, 300],
  [3600, 300],
  [100, 45],
  [30, 10],
  [12, 1],
])("the headless wait states a bound below the turn timeout %s", (timeout, bound) => {
  const prompt = waitPrompt(timeout);
  for (const { command } of WAIT_COMMAND) {
    expect(prompt).toContain(`${command} --pr 42 --timeout ${bound}`);
  }
  expect(prompt).not.toContain("--watch");
  expect(prompt).not.toContain("few minutes");
  if (typeof timeout === "number") {
    expect(bound + 5).toBeLessThan(timeout);
  }
});

// Usefulness: verifies no turn timeout gets a wait that can outlast it (issue #348). Every timeout
// either gets a positive bound whose wait and five-second child-exit window end inside the turn, or
// gets no wait command at all.
test("no turn timeout gets a wait that outlasts the turn", () => {
  for (let timeout = 1; timeout <= 700; timeout += 1) {
    const prompt = waitPrompt(timeout);
    const stated = prompt.match(/role wait-checks --cwd "[^"]*" --pr 42 --timeout (\d+)/);
    if (stated === null) {
      expect(timeout, "a turn that fits a wait names none").toBeLessThan(12);
      expect(prompt).toMatch(/cannot wait for the required checks/i);
      expect(prompt).toMatch(/do not run agent-loop role wait-checks/i);
      continue;
    }
    const bound = Number(stated[1]);
    expect(bound).toBeGreaterThanOrEqual(1);
    expect(bound + 5).toBeLessThan(timeout);
  }
});

// Usefulness: verifies a run whose turn is too short for any wait tells the orchestrator to rely on
// the gate (issue #348). It does not run a wait that ends the run.
test.each([1, 2, 5, 10, 11])("a %s second turn names no wait", (timeout) => {
  const prompt = waitPrompt(timeout);
  expect(prompt).not.toContain("--pr 42 --timeout");
  expect(prompt).not.toContain("Wait for the required checks at two points");
  expect(prompt).toMatch(/too short/i);
  expect(prompt).toMatch(/abort with the pending check/i);
});

// Usefulness: verifies the ADR 0010 child-exit rule reaches the headless
// orchestrator, so an unobserved exit is not read as a clean machine (issue #348).
test("the headless wait states the childExitUnconfirmed rule", () => {
  const prompt = waitPrompt(3600).replace(/\s+/g, " ");
  expect(prompt).toMatch(/"childExitUnconfirmed": true[^.]*unaccounted/i);
  expect(prompt).toMatch(/settle that process before you start another wait/i);
});

// Usefulness: verifies the wait prompt and its bound follow `CHILD_EXIT_CEILING_MS`.
// A constant change then leaves no stale number in the prompt text.
// It also renders no fractional `--timeout`, which the CLI rejects (issue #736).
test.each([
  [5000, 7, "five"],
  [2500, 7, "three"],
  [12000, 4, "12"],
])(
  "the headless wait prompt follows a %i ms child-exit ceiling",
  async (ceilingMs, bound, word) => {
    vi.resetModules();
    vi.doMock("../../src/lib/check-wait.mjs", async (importOriginal) => ({
      ...(await importOriginal()),
      CHILD_EXIT_CEILING_MS: ceilingMs,
    }));
    try {
      const { initialPrompt: render, headlessWaitSeconds } =
        await import("../../src/prompts/orchestrator.mjs");
      expect(headlessWaitSeconds(2 * (bound + Math.ceil(ceilingMs / 1000)))).toBe(bound);
      const prompt = render({
        task: "T",
        maxSteps: 10,
        requireCi: 42,
        orchestratorKind: "claude",
        reviewerKind: "claude",
        timeout: 2 * (bound + Math.ceil(ceilingMs / 1000)),
        waitCommand: WAIT_COMMAND,
      }).replace(/\s+/g, " ");
      expect(prompt).toMatch(new RegExp(`--pr 42 --timeout ${bound}(?![.\\d])`));
      expect(prompt).toContain(`${bound} seconds plus ${word}, before this turn ends`);
      expect(prompt).toContain(`${word}-second window expired`);
    } finally {
      vi.doUnmock("../../src/lib/check-wait.mjs");
      vi.resetModules();
    }
  },
);

// Usefulness: verifies the wait prompt names the `DEFAULT_TIMEOUT` value when the run sets
// no turn timeout. The stated default then cannot drift from the CLI default.
test("the headless wait prompt states the DEFAULT_TIMEOUT value", async () => {
  vi.resetModules();
  vi.doMock("../../src/lib/args.mjs", async (importOriginal) => ({
    ...(await importOriginal()),
    DEFAULT_TIMEOUT: 1800,
  }));
  try {
    const { initialPrompt: render } = await import("../../src/prompts/orchestrator.mjs");
    const prompt = render({
      task: "T",
      maxSteps: 10,
      requireCi: 42,
      orchestratorKind: "claude",
      reviewerKind: "claude",
      waitCommand: WAIT_COMMAND,
    }).replace(/\s+/g, " ");
    expect(prompt).toContain("(1800 seconds by default)");
  } finally {
    vi.doUnmock("../../src/lib/args.mjs");
    vi.resetModules();
  }
});

// Usefulness: verifies the platform decides the shell forms (issue #348). A Windows run gets a
// PowerShell form with the call operator and a bash-or-cmd form without it. Any other platform gets
// one plain form.
test("the wait command renders the shell forms of the platform", () => {
  const input = {
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "D:\\a b\\cli.mjs",
    cwd: "E:\\work tree",
  };
  const plain = '"C:/Program Files/nodejs/node.exe" "D:/a b/cli.mjs" role wait-checks --cwd "';
  const win = waitChecksCommand({ ...input, platform: "win32" });
  expect(win.map((form) => form.shell)).toEqual(["PowerShell", "bash or cmd"]);
  expect(win[0].command.startsWith(`& ${plain}`)).toBe(true);
  expect(win[1].command.startsWith(plain)).toBe(true);
  expect(win[1].command.endsWith('work tree"')).toBe(true);

  const posix = waitChecksCommand({
    execPath: "/opt/node",
    cliPath: "/opt/a b/cli.mjs",
    cwd: "/srv/work tree",
    platform: "linux",
  });
  expect(posix).toEqual([
    {
      shell: "sh",
      command: `"/opt/node" "/opt/a b/cli.mjs" role wait-checks --cwd "/srv/work tree"`,
    },
  ]);
});

// Usefulness: verifies the command carries the resolved work tree of the run (issue #348). The wait
// then reads the right repository, whatever directory the shell starts in. The prompt passes the
// `cwd` of the run through.
test("the wait command and the prompt carry the resolved work tree", () => {
  const forms = waitChecksCommand({ cwd: "relative/tree" });
  expect(forms[0].command).toContain(`--cwd "${resolve("relative/tree").replaceAll("\\", "/")}"`);
  const prompt = initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout: 3600,
    cwd: "/srv/run tree",
  });
  expect(prompt).toContain(`--cwd "${resolve("/srv/run tree").replaceAll("\\", "/")}" --pr 42`);
});

// Every character that bash, PowerShell, or cmd expands or reinterprets inside a
// double-quoted argument. ADR 0013 lists the same set.
const UNSAFE_CHARACTERS = [
  ['"', "double quote"],
  ["$", "dollar"],
  ["`", "backtick"],
  ["%", "percent (cmd)"],
  ["!", "exclamation (cmd delayed expansion, bash history)"],
  ["\u201C", "left double quotation mark (PowerShell quote)"],
  ["\u201D", "right double quotation mark (PowerShell quote)"],
  ["\u201E", "low double quotation mark (PowerShell quote)"],
  ["\n", "line feed"],
  ["\r", "carriage return"],
  ["\t", "tab"],
  ["\u0000", "NUL"],
  ["\u{85}", "next line (escaped in every prompt, so the command would name another path)"],
  ["\u{2028}", "line separator (escaped in every prompt)"],
  ["\u{2029}", "paragraph separator (escaped in every prompt)"],
];

// Usefulness: verifies a Node, CLI, or work tree path that holds a character a shell expands inside
// double quotes gets no command (issue #348). The prompt never renders a command that runs
// something else.
test.each(UNSAFE_CHARACTERS)("the wait command refuses a path holding %j (%s)", (char) => {
  const safe = { execPath: "/opt/node", cliPath: "/opt/cli.mjs", cwd: "/srv/tree" };
  expect(waitChecksCommand({ ...safe, platform: "linux" })).not.toBeNull();
  for (const key of ["execPath", "cliPath", "cwd"]) {
    const input = { ...safe, [key]: `${safe[key]}${char}x`, platform: "linux" };
    expect(waitChecksCommand(input), key).toBeNull();
    expect(waitChecksCommand({ ...input, platform: "win32" }), key).toBeNull();
  }
});

// Usefulness: verifies a POSIX path keeps its backslashes or is refused, and is never rewritten
// (issue #348). A POSIX backslash is a name character, so a slash in its place points the command
// at another path. The slash rewrite stays Windows-only.
test("a POSIX path is never rewritten and a backslash in it is refused", () => {
  const safe = { execPath: "/opt/node", cliPath: "/opt/cli.mjs", cwd: "/srv/tree" };
  const rendered = waitChecksCommand({ ...safe, platform: "linux" });
  expect(rendered[0].command).toBe('"/opt/node" "/opt/cli.mjs" role wait-checks --cwd "/srv/tree"');
  for (const key of ["execPath", "cliPath", "cwd"]) {
    const input = { ...safe, [key]: `${safe[key]}/dir\\name`, platform: "linux" };
    expect(waitChecksCommand(input), key).toBeNull();
  }
  // The same character is a separator on Windows and becomes a slash there.
  const win = waitChecksCommand({
    execPath: "C:\\node\\node.exe",
    cliPath: "C:\\repo\\cli.mjs",
    cwd: "C:\\repo",
    platform: "win32",
  });
  expect(win[1].command).toBe(
    '"C:/node/node.exe" "C:/repo/cli.mjs" role wait-checks --cwd "C:/repo"',
  );
});

// Usefulness: verifies a run with no renderable command names no wait, and says why (issue #348).
// It does not name a wait command that the shell misreads.
test("a run with no renderable command names no wait", () => {
  const prompt = waitPrompt(3600, { waitCommand: null });
  expect(prompt).not.toContain("--pr 42 --timeout");
  expect(prompt).toMatch(/cannot wait for the required checks/i);
  expect(prompt).toMatch(/work tree that every shell reads the same way/i);
});

// Usefulness: verifies a work tree path that holds U+2028 or U+2029 leads to the no-wait fallback
// through the default command (issue #761). The prompt never tells the reader to run a command
// whose path the prompt escape rewrote.
test.each(["\u{2028}", "\u{2029}", "\u{85}"])(
  "a work tree path holding a line separator gives the no-wait fallback",
  (char) => {
    const prompt = initialPrompt({
      task: "T",
      maxSteps: 10,
      requireCi: 42,
      orchestratorKind: "claude",
      reviewerKind: "claude",
      timeout: 3600,
      cwd: `/srv/tree${char}x`,
    });
    expect(prompt).not.toContain("--pr 42 --timeout");
    expect(prompt).toMatch(/cannot wait for the required checks/i);
  },
);

const isWindows = process.platform === "win32";

// Resolves true when `command` starts, whatever its exit code.
async function canRun(command, args) {
  const run = await execa(command, args, { reject: false });
  return !run.failed || run.exitCode !== undefined;
}

const hasBash = await canRun("bash", ["-c", "exit 0"]);

const hasPowerShell =
  isWindows && (await canRun("powershell", ["-NoProfile", "-Command", "exit 0"]));

// Runs one rendered form in a real shell and returns the combined output. The
// script goes through a file so the shell parses exactly the text the prompt
// carries. No --pr is given, so the CLI refuses before it reads anything.
async function runForm(shell, command, dir) {
  if (shell === "bash") {
    return execa("bash", ["-c", command], { reject: false, all: true });
  }
  if (shell === "powershell") {
    const script = join(dir, "form.ps1");
    await writeFile(script, `${command}\n`);
    return execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      reject: false,
      all: true,
    });
  }
  const script = join(dir, "form.cmd");
  await writeFile(script, `@echo off\r\n${command}\r\n`);
  return execa("cmd", ["/d", "/c", script], { reject: false, all: true });
}

// Usefulness: verifies each rendered form starts the CLI in a real shell, with a Node path and a
// work tree path that hold spaces. A form that a shell rejects leaves the orchestrator with no
// wait. PowerShell needs the call operator, and bash and cmd reject it (issue #348).
describe("the rendered wait forms run in a real shell", () => {
  const withDir = async (run) => {
    const dir = await mkdtemp(join(tmpdir(), "wait form "));
    try {
      const scripts = await mkdtemp(join(tmpdir(), "waitform-"));
      try {
        return await run(dir, scripts);
      } finally {
        await rm(scripts, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const REFUSED = /wait-checks requires --pr/;

  test.skipIf(isWindows || !hasBash)("the sh form runs in bash", async () => {
    await withDir(async (cwd, scripts) => {
      const [form] = waitChecksCommand({ cwd });
      const run = await runForm("bash", form.command, scripts);
      expect(run.all).toMatch(REFUSED);
    });
  });

  test.skipIf(!isWindows || !hasBash)("the bash-or-cmd form runs in bash", async () => {
    await withDir(async (cwd, scripts) => {
      const form = waitChecksCommand({ cwd }).find((f) => f.shell === "bash or cmd");
      const run = await runForm("bash", form.command, scripts);
      expect(run.all).toMatch(REFUSED);
    });
  });

  test.skipIf(!isWindows)(
    "the bash-or-cmd form runs in cmd, and the call operator does not",
    async () => {
      await withDir(async (cwd, scripts) => {
        const forms = waitChecksCommand({ cwd });
        const plain = forms.find((f) => f.shell === "bash or cmd");
        const ok = await runForm("cmd", plain.command, scripts);
        expect(ok.all).toMatch(REFUSED);
        const rejected = await runForm(
          "cmd",
          forms.find((f) => f.shell === "PowerShell").command,
          scripts,
        );
        expect(rejected.all).not.toMatch(REFUSED);
      });
    },
  );

  test.skipIf(!hasPowerShell)(
    "the PowerShell form runs in PowerShell, and the plain form does not",
    async () => {
      await withDir(async (cwd, scripts) => {
        const forms = waitChecksCommand({ cwd });
        const ok = await runForm(
          "powershell",
          forms.find((f) => f.shell === "PowerShell").command,
          scripts,
        );
        expect(ok.all).toMatch(REFUSED);
        const rejected = await runForm(
          "powershell",
          forms.find((f) => f.shell === "bash or cmd").command,
          scripts,
        );
        expect(rejected.all).not.toMatch(REFUSED);
      });
    },
  );
});

// Usefulness: verifies the default prompt names a command built from this install (issue #348). A
// bare `agent-loop` has no PATH entry in a clone run. The rendered Node binary and CLI script
// exist.
test("the default wait command names the Node binary and CLI script of this run", async () => {
  const prompt = initialPrompt({
    task: "T",
    maxSteps: 10,
    requireCi: 42,
    orchestratorKind: "claude",
    reviewerKind: "claude",
    timeout: 3600,
  });
  const match = prompt.match(
    /"([^"]+)" "([^"]+)" role wait-checks --cwd "[^"]+" --pr 42 --timeout 300/,
  );
  expect(match).not.toBeNull();
  const [, node, cli] = match;
  expect(node).toBe(process.execPath.replaceAll("\\", "/"));
  expect(prompt).not.toMatch(/agent-loop role wait-checks --pr/);
  await access(cli);
});
