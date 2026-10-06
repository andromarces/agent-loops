import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vite-plus/test";
import { redactEnvSecrets } from "../../src/lib/redact.mjs";
import { TAIL_CHARS, redactCommandText, runTestCmd } from "../../src/lib/test-cmd.mjs";
import { createTempRepo, removePath } from "../runtime-helpers.mjs";

const dirs = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await removePath(dir);
  }
});

async function repo() {
  const dir = await createTempRepo();
  dirs.push(dir);
  return dir;
}

// One shell-neutral way to run a JS body: double quotes outside, single quotes inside.
const node = (body) => `node -e "${body}"`;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// Usefulness: verifies a passing command reports exit 0 and its output, so the
// reviewer sees the evidence the runtime read (issue #420).
test("a passing command reports pass, exit 0, and its output", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log('3 tests passed')"), cwd });
  expect(run).toMatchObject({
    status: "pass",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    workTreeChanged: false,
    advisory: true,
  });
  expect(run.tail).toContain("3 tests passed");
});

// Usefulness: verifies a failing command reports its own exit code as a failure,
// not as a pass and not as an error (issue #420).
test("a failing command reports fail with its exit code", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node("console.error('1 test failed'); process.exit(3)"),
    cwd,
  });
  expect(run).toMatchObject({ status: "fail", exitCode: 3, timedOut: false });
  expect(run.summary).toBe("exit 3");
  expect(run.tail).toContain("1 test failed");
});

// Usefulness: verifies the command runs in the given work tree, which is the
// run's `--cwd` (issue #420).
test("the command runs in the given work tree", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log(process.cwd())"), cwd });
  const printed = run.tail.trim();
  expect(await readFile(join(printed, "init.txt"), "utf8")).toBe("hello\n");
});

// A command that records its pid and starts a process tree, then hangs. `orphan` starts the grandchild from an intermediate process
// that exits at once, so the grandchild has no live parent: it is reparented away from
// the command, and no walk of the parent links finds it. `trapTerm` makes the command
// exit 0 on SIGTERM, the shape of a runner that cleans up and exits.
async function hangingTree({ orphan = false, trapTerm = false }) {
  const dir = await mkdtemp(join(tmpdir(), "test-cmd-hang-"));
  dirs.push(dir);
  const grandchildPid = join(dir, "grandchild.pid");
  const childPid = join(dir, "child.pid");
  const grandchild = join(dir, "grandchild.js");
  const middle = join(dir, "middle.js");
  const child = join(dir, "child.js");
  const record = (file) =>
    `require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid));`;
  const spawnGrandchild = `require("child_process").spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" }).unref();`;
  await writeFile(grandchild, `${record(grandchildPid)}\nsetTimeout(() => {}, 60000);\n`);
  await writeFile(middle, `${spawnGrandchild}\n`);
  const start = orphan
    ? `const mid = require("child_process").spawn(process.execPath, [${JSON.stringify(middle)}], { stdio: "ignore" });\nmid.on("exit", () => setTimeout(() => {}, 60000));`
    : spawnGrandchild;
  await writeFile(
    child,
    `${record(childPid)}\n${start}\n${trapTerm ? 'process.on("SIGTERM", () => process.exit(0));' : ""}\nsetTimeout(() => {}, 60000);\n`,
  );
  return { command: `node "${child}"`, pidFiles: [childPid, grandchildPid] };
}

// Waits until every file holds a pid, so a cancel never precedes the processes it must kill.
async function waitForPidFiles(files) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pids = await Promise.all(
      files.map((file) => readFile(file, "utf8").then(Number.parseInt, () => Number.NaN)),
    );
    if (pids.every(Number.isInteger)) {
      return;
    }
    expect(Date.now() < deadline, "the process tree never started").toBe(true);
    await delay(50);
  }
}

// Both processes record their pids before the bound, or the test fails: a child
// that never ran proves nothing about the kill. The survival check runs before any
// cleanup kill, so a leaked process fails the test, and the cleanup in `finally`
// only keeps a failed test from leaving a process behind.
async function expectAllGone(pidFiles) {
  const pids = [];
  for (const file of pidFiles) {
    const pid = Number.parseInt(await readFile(file, "utf8"), 10);
    expect(Number.isInteger(pid), `${file} holds no pid, so the process never started`).toBe(true);
    pids.push(pid);
  }
  try {
    const deadline = Date.now() + 4000;
    while (pids.some(processExists) && Date.now() < deadline) {
      await delay(50);
    }
    const survivors = pids.filter(processExists);
    expect(survivors, `processes outlived the kill: ${survivors.join(", ")}`).toEqual([]);
  } finally {
    for (const pid of pids.filter(processExists)) {
      process.kill(pid, "SIGKILL");
    }
  }
}

// Usefulness: verifies a command that runs past its bound is reported as timed
// out, never as a failure or a pass, and that the command and the child process
// it started, which stay in its process group, are both gone (issue #420). The bound
// is 3 seconds, the floor of a whole second plus time for both node processes to
// start on a loaded machine.
test("a timeout kills the command and its child process and reports timed-out", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({});
  const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
  expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
  expect(run.summary).toContain("neither a pass nor a failure");
  expect(run.summary).toContain("an orphan that left it can survive");
  await expectAllGone(pidFiles);
}, 20_000);

// Usefulness: verifies a timed-out result carries exitCode null whatever the
// command exits with after the kill signal, as the ADR and the docs state, so a
// parent never reads a timeout as the exit code of a runner that trapped the
// signal and exited 0 (issue #420 review).
test("a timed-out command reports exitCode null even when it exits 0 on the signal", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({ trapTerm: true });
  const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
  expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
  expect(run.summary).not.toContain("exit 0");
  await expectAllGone(pidFiles);
}, 20_000);

// Usefulness: verifies a timeout kills an orphan that stayed in the process group of the
// command, the group the runtime creates and owns. The guarantee differs by platform: POSIX
// reaches the orphan through the group, and Windows has no group and reaches only the live
// parent links, so the maintainer-approved limit of ADR 0017 keeps an orphan there (issue
// #420, approved 2026-10-04).
test.skipIf(process.platform === "win32")(
  "POSIX only: a timeout kills an orphan that stayed in the process group of the command",
  async () => {
    const cwd = await repo();
    const { command, pidFiles } = await hangingTree({ orphan: true });
    const run = await runTestCmd({ command, timeoutSeconds: 3, cwd });
    expect(run).toMatchObject({ status: "timed-out", timedOut: true, exitCode: null });
    await expectAllGone(pidFiles);
  },
  20_000,
);

// Usefulness: verifies a cancel kills the command and its child on every platform, so an
// aborted run leaves no process of the command's own group or tree behind (issue #420).
test("a cancel kills the command and its child process", async () => {
  const cwd = await repo();
  const { command, pidFiles } = await hangingTree({});
  const controller = new AbortController();
  const pending = runTestCmd({ command, timeoutSeconds: 60, cwd, signal: controller.signal });
  const outcome = pending.catch((err) => err);
  await waitForPidFiles(pidFiles);
  controller.abort();
  expect(await outcome).toMatchObject({ isCanceled: true });
  await expectAllGone(pidFiles);
}, 30_000);

// Usefulness: verifies a cancel still compares the work tree and carries the result on
// the error, so a write the command made before the cancel is reported and not lost
// (issue #420 review of aa0b25e).
test("a cancel reports the work tree change the command made before it", async () => {
  const cwd = await repo();
  const controller = new AbortController();
  const pending = runTestCmd({
    command: node("require('fs').writeFileSync('early.txt', 'x'); setTimeout(() => {}, 60000)"),
    cwd,
    signal: controller.signal,
  });
  const outcome = pending.catch((err) => err);
  const deadline = Date.now() + 10_000;
  while (!(await readFile(join(cwd, "early.txt"), "utf8").catch(() => null))) {
    expect(Date.now() < deadline, "the command never wrote its file").toBe(true);
    await delay(50);
  }
  controller.abort();
  const error = await outcome;
  expect(error.isCanceled).toBe(true);
  expect(error.testRun.summary).toContain("an orphan that left it can survive");
  expect(error.testRun).toMatchObject({
    status: "canceled",
    exitCode: null,
    workTreeChanged: true,
    changedPaths: ["early.txt"],
  });
}, 20_000);

// Usefulness: verifies an output far over the capture window is cut to the tail,
// keeps the end of the output, and reports the cut, so a noisy suite cannot
// exhaust memory or the reviewer prompt (issue #420).
test("an output over the cap is cut to its tail", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node("for (let i = 0; i < 20000; i++) console.log('line ' + i)"),
    cwd,
  });
  expect(run.status).toBe("pass");
  expect(run.truncated).toBe(true);
  expect(run.outputBytes).toBeGreaterThan(200_000);
  expect(run.tail.length).toBeLessThanOrEqual(TAIL_CHARS);
  expect(run.tail.trimEnd().endsWith("line 19999")).toBe(true);
  expect(run.tail).not.toContain("line 0\n");
});

// Usefulness: verifies a command that writes to the work tree is reported with
// the changed paths, a created file and an edited tracked file alike, so the
// writes do not silently become the reviewer baseline (issue #420).
test("a command that changes the work tree reports the changed paths", async () => {
  const cwd = await repo();
  const run = await runTestCmd({
    command: node(
      "const fs = require('fs'); fs.writeFileSync('new.txt', 'x'); fs.appendFileSync('init.txt', 'y')",
    ),
    cwd,
  });
  expect(run).toMatchObject({ status: "pass", workTreeChanged: true, changedCount: 2 });
  expect(run.changedPaths).toEqual(["init.txt", "new.txt"]);
});

// Usefulness: verifies a command that leaves the work tree as it found it
// reports no change, so the report is not noise on every run (issue #420).
test("a command that leaves the work tree alone reports no change", async () => {
  const cwd = await repo();
  const run = await runTestCmd({ command: node("console.log('ok')"), cwd });
  expect(run).toMatchObject({ workTreeChanged: false, changedPaths: [], changedCount: 0 });
});

// Usefulness: verifies the value of a secret-named environment variable never
// reaches the tail or the reported command, because the tail goes to a model and
// a transcript (issue #420).
test("a secret-named environment value is redacted from the tail and the command", async () => {
  const cwd = await repo();
  process.env.TEST_CMD_PROBE_TOKEN = "probe-secret-value-123";
  try {
    const run = await runTestCmd({
      command: node("console.log(process.env.TEST_CMD_PROBE_TOKEN)"),
      cwd,
    });
    expect(run.tail).toContain("[redacted:TEST_CMD_PROBE_TOKEN]");
    expect(run.tail).not.toContain("probe-secret-value-123");
    const inline = await runTestCmd({
      command: `${node("console.log('x')")} probe-secret-value-123`,
      cwd,
    });
    expect(inline.command).not.toContain("probe-secret-value-123");
  } finally {
    delete process.env.TEST_CMD_PROBE_TOKEN;
  }
});

// Usefulness: verifies a short value is never redacted, because a short value
// would match ordinary words and destroy the tail (issue #420).
test("a short secret-named value is not redacted", () => {
  expect(redactEnvSecrets("a 1234 b", { MY_TOKEN: "1234" })).toBe("a 1234 b");
});

// Usefulness: verifies a canceled run throws a cancel the caller already handles
// and kills the command it was running (issue #420).
test("an abort signal cancels the command", async () => {
  const cwd = await repo();
  const controller = new AbortController();
  const pending = runTestCmd({
    command: node("setTimeout(() => {}, 60000)"),
    cwd,
    signal: controller.signal,
  });
  await delay(300);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ isCanceled: true });
}, 20_000);

// Usefulness: verifies the secret name test ignores case, so a Windows variable that the OS reports
// as `Github_Token` is redacted like `GITHUB_TOKEN` (issue #431, ADR 0017).
test("a secret-named value is redacted whatever the case of the variable name", () => {
  expect(redactEnvSecrets("x synthetic-value-9a8b y", { My_Token: "synthetic-value-9a8b" })).toBe(
    "x [redacted:My_Token] y",
  );
});

// Usefulness: verifies the trade-off of ADR 0017: a secret-named value that is also a common word
// is still redacted, and the marker names the variable, so a reader knows what the text masked.
test("a common-word secret-named value stays redacted and the marker names the variable", () => {
  const out = redactEnvSecrets("connect failed in production", { APP_AUTH_MODE: "production" });
  expect(out).toBe("connect failed in [redacted:APP_AUTH_MODE]");
});

// Usefulness: verifies a value with a quote and a backslash is redacted in its JSON-escaped form too,
// because a serialized error object holds the escaped text and a decoder recovers the value from it
// (issue #431, ADR 0017).
test("a value with a quote and a backslash is redacted in its JSON-escaped form", () => {
  const value = 'synthetic"probe\\value-8f3a1c';
  const env = { SYNTH_PROBE_TOKEN: value };
  const escaped = JSON.stringify(value).slice(1, -1);
  expect(redactEnvSecrets(`raw ${value} json ${escaped}`, env)).toBe(
    "raw [redacted:SYNTH_PROBE_TOKEN] json [redacted:SYNTH_PROBE_TOKEN]",
  );
});

// Usefulness: verifies no fragment of a secret survives when one value is a prefix of another,
// the case that a per-value replacement order leaves open (issue #521, ADR 0017).
test("a secret that is a prefix of another secret leaves no fragment", () => {
  const env = { A_TOKEN: "prefixvalue", B_TOKEN: "prefixvalue-TAILSUFFIX" };
  const out = redactEnvSecrets("x prefixvalue-TAILSUFFIX y", env);
  expect(out).not.toContain("TAILSUFFIX");
  expect(out).not.toContain("prefixvalue");
});

// Usefulness: verifies two secrets that cross without one holding the other leave no fragment (issue #521).
test("two crossing secret occurrences leave no fragment", () => {
  const env = { A_TOKEN: "aaaa-SHARED-1", B_TOKEN: "SHARED-1-zzzz9" };
  const out = redactEnvSecrets("x aaaa-SHARED-1-zzzz9 y", env);
  expect(out).not.toContain("SHARED");
  expect(out).not.toContain("zzzz9");
  expect(out).not.toContain("aaaa");
  expect(out.startsWith("x [redacted:")).toBe(true);
  expect(out.endsWith("] y")).toBe(true);
});

// Usefulness: verifies overlapping occurrences of one value are masked as one run (issue #521).
test("a self-overlapping secret occurrence leaves no fragment", () => {
  const out = redactEnvSecrets("x abcabcabcabc y", { SELF_TOKEN: "abcabcabc" });
  expect(out).toBe("x [redacted:SELF_TOKEN] y");
});

// Usefulness: verifies a value that starts with a quote is redacted in its escaped form with the
// main output: the raw match leaves the escape backslash, and no value stays (issue #521).
test("a value that starts with a quote leaves only the escape backslash", () => {
  const value = '"abcdefg';
  const escaped = JSON.stringify(value).slice(1, -1);
  const out = redactEnvSecrets(`x ${escaped} y`, { RAW_TOKEN: value });
  expect(out).toBe("x \\[redacted:RAW_TOKEN] y");
});

// Usefulness: verifies a marker never holds a secret value, even when a variable name does (issue #521, ADR 0017).
test("a marker does not hold a secret value that is part of its variable name", () => {
  const env = { LONG_SECRETVALUE_NAME_TOKEN: "synthetic-aaa-1", SHORT_TOKEN: "SECRETVALUE" };
  const out = redactEnvSecrets("a synthetic-aaa-1 b", env);
  expect(out).not.toContain("SECRETVALUE");
  expect(out).not.toContain("synthetic-aaa-1");
  expect(out).toContain("a [");
});

// Usefulness: verifies a long text with a long repetitive value finishes in bounded time (issue #521).
test("a long repetitive text with a long secret value redacts in bounded time", () => {
  const value = "a".repeat(64 * 1024);
  const text = "a".repeat(128 * 1024);
  const start = performance.now();
  const out = redactEnvSecrets(text, { BIG_TOKEN: value });
  expect(performance.now() - start).toBeLessThan(500);
  expect(out).toBe("[redacted:BIG_TOKEN]");
});

// Verbatim copy of `redactEnvSecrets` from origin/main before issue #521 (`git show origin/main:src/lib/redact.mjs`),
// renamed only. Reference for the parity tests.
const MAIN_MIN_SECRET_LENGTH = 8;
const MAIN_SECRET_NAME = /token|secret|passw|key|credential|auth/i;

/**
 * Replaces every occurrence of the value of a secret-named environment variable
 * with `[redacted:NAME]`, in its raw form and in its JSON-escaped form, because a
 * serialized error holds the escaped text and a decoder recovers the value from it.
 * Exact-value match only: a secret that the command derives, encodes, or reads from
 * a file is not found.
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 */
function redactEnvSecretsOnMain(text, env = process.env) {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (
      MAIN_SECRET_NAME.test(name) &&
      typeof value === "string" &&
      value.length >= MAIN_MIN_SECRET_LENGTH
    ) {
      const marker = `[redacted:${name}]`;
      out = out.split(value).join(marker);
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) {
        out = out.split(escaped).join(marker);
      }
    }
  }
  return out;
}

const formsOf = (env) =>
  Object.values(env).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);

// Usefulness: verifies the text after a marker cannot join the marker to rebuild the JSON-escaped
// form of a value (issue #521, ADR 0017). The variable name ends in the value's first character.
test("a marker and the text after it do not rebuild the escaped form of a value", () => {
  const value = 'x]"abcdefg';
  const env = { A_TOKENx: value };
  const out = redactEnvSecrets(`${value}\\"abcdefg`, env);
  for (const form of formsOf(env)) {
    expect(out).not.toContain(form);
  }
});

// Usefulness: verifies two adjacent markers cannot rebuild the raw value of another secret (issue #521).
test("adjacent markers do not rebuild the raw value of another secret", () => {
  const env = { A_TOKEN: "synthetic-aaa", C_KEY: "TOKEN][redacted:A_TOKEN" };
  const out = redactEnvSecrets("synthetic-aaasynthetic-aaa", env);
  for (const form of formsOf(env)) {
    expect(out).not.toContain(form);
  }
});

// Usefulness: verifies a single secret that overlaps nothing gives the output of the pass-based
// redaction, at the start, at the end, repeated, next to marker-like text, and with brackets (issue #521).
test.each([
  ["start", "synthetic-aaa tail"],
  ["end", "head synthetic-aaa"],
  ["alone", "synthetic-aaa"],
  ["adjacent repeats", "synthetic-aaasynthetic-aaa"],
  ["marker-like text before", "[redacted:A_TOKEN synthetic-aaa"],
  ["marker-like text after", "synthetic-aaa[redacted:A_TOKEN]"],
  ["bracket text", "]synthetic-aaa["],
  ["no match", "nothing here"],
])("a single non-overlapping secret keeps the pass-based output: %s", (_label, text) => {
  const env = { A_TOKEN: "synthetic-aaa", B_TOKEN: "other-unused-1" };
  expect(redactEnvSecrets(text, env)).toBe(redactEnvSecretsOnMain(text, env));
});

// Usefulness: same parity for a value with brackets and for a value with a quote and a backslash (issue #521).
test.each([
  ["brackets", "pa]ss[word1", "x pa]ss[word1 y"],
  ["quote and backslash", 'q"b\\vvvvv', 'x q"b\\vvvvv y and q\\"b\\\\vvvvv z'],
])("a single secret with %s keeps the pass-based output", (_label, value, text) => {
  const env = { A_TOKEN: value };
  expect(redactEnvSecrets(text, env)).toBe(redactEnvSecretsOnMain(text, env));
});

// Usefulness: verifies the command text path cannot rebuild a value when it removes a control character
// that sat inside the value (issue #521, ADR 0017): redaction runs again after the cleanup.
test("the command text does not rebuild a value after control characters are removed", () => {
  process.env.TEST_CMD_PROBE_TOKEN = "abcdefgh";
  try {
    expect(redactCommandText("run abcd\u0001efgh now")).not.toContain("abcdefgh");
  } finally {
    delete process.env.TEST_CMD_PROBE_TOKEN;
  }
});

// Usefulness: verifies the tail path has the same guarantee as the command text path (issue #521).
test("the tail does not rebuild a value after control characters are removed", async () => {
  const cwd = await repo();
  process.env.TEST_CMD_PROBE_TOKEN = "abcdefgh";
  try {
    const run = await runTestCmd({
      command: node("process.stdout.write('abcd' + String.fromCharCode(1) + 'efgh')"),
      cwd,
    });
    expect(run.tail).not.toContain("abcdefgh");
  } finally {
    delete process.env.TEST_CMD_PROBE_TOKEN;
  }
});

// Usefulness: verifies a second redaction of an output is a no-op, so a later redaction (a log line cut,
// a caller cleanup) never grows a bounded text (issue #521).
test.each([
  [{ A_TOKENx: 'x]"abcdefg' }, 'x]"abcdefg\\"abcdefg'],
  [{ A_TOKEN: "synthetic-aaa", C_KEY: "TOKEN][redacted:A_TOKEN" }, "synthetic-aaasynthetic-aaa"],
  [{ A_TOKEN: "abcabcabc", B_KEY: "abcabcabcXYZW" }, "q abcabcabcXYZW abcabcabcabc"],
  [{ LONG_SECRETVALUE_TOKEN: "synthetic-aaa-1", SHORT_KEY: "SECRETVALUE" }, "a synthetic-aaa-1 b"],
])("a second redaction of the output changes nothing: %j", (env, text) => {
  const once = redactEnvSecrets(text, env);
  expect(redactEnvSecrets(once, env)).toBe(once);
});

// Usefulness: verifies the redaction ends and leaves no value when every character that a marker
// could use appears in some value (issue #521).
test("the redaction ends when every candidate marker character is part of a value", () => {
  let every = "";
  for (let code = 0; code < 0x10000; code++) every += String.fromCharCode(code);
  const env = { A_TOKENx: 'x]"abcdefg', ALL_CHARS_KEY: every };
  const out = redactEnvSecrets('x]"abcdefg\\"abcdefg', env);
  for (const form of formsOf(env)) {
    expect(out).not.toContain(form);
  }
});

// Usefulness: verifies a marker never shows a variable name that holds a value, and no fragment of
// the escaped form stays after the marker (issue #521).
test("a boundary hit between a marker and the text after it leaves no fragment", () => {
  const out = redactEnvSecrets('x]"abcdefg\\"abcdefg', { A_TOKENx: 'x]"abcdefg' });
  expect(out).not.toContain("abcdefg");
});

// Usefulness: verifies the redaction of an adversarial cascade stays near-linear (issue #521). Each
// round of a naive rescan removes one layer of this text, so many rounds would cost a quadratic scan.
test("an adversarial cascade input redacts in bounded time and leaves no value", () => {
  const value = "ab[*]cdef";
  const env = { "X_ab[*]cdef_KEY": value };
  const layers = 20_000;
  const text = `${"ab".repeat(layers)}[*]${"cdef".repeat(layers)}`;
  const start = performance.now();
  const out = redactEnvSecrets(text, env);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(out).not.toContain(value);
  expect(redactEnvSecrets(out, env)).toBe(out);
});

// Usefulness: verifies the repeated cut redaction of a log line never grows the line past the bound
// of 300 characters plus the cut marker (issue #521).
test("a redaction after the log cut keeps the line within the bound", () => {
  const env = { AGENT_TEST_SECRET: "abcdefgh..." };
  const cut = `${"x".repeat(292)}abcdefgh${"y".repeat(20)}`.slice(0, 300) + "...";
  const out = redactEnvSecrets(cut, env, { shrink: true });
  expect(out.length).toBeLessThanOrEqual(cut.length);
  expect(out).not.toContain("abcdefgh...");
});

// Usefulness: verifies a single secret that overlaps nothing gives the output of the main algorithm over a
// systematic set of boundary inputs, so the one exception of ADR 0017 stays the only difference (issue #521).
test("a single secret keeps the main output over systematic boundary inputs", () => {
  const values = [
    "abcdefgh",
    "abcdefgh]",
    "[abcdefgh",
    "abcd:efgh",
    'a"bcdefgh',
    "a\\bcdefgh",
    '"abcdefgh',
    "\\abcdefgh",
    "abcdefgh\\",
    'abcdefgh"',
    'x]"abcdefg',
    "ab[cd]efgh",
  ];
  const names = ["A_TOKEN", "A_TOKENx", "xA_TOKEN", "A_TOKENh", "A_KEY]", "A_TOKEN:"];
  let compared = 0;
  for (const value of values) {
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const name of names) {
      const env = { [name]: value };
      const marker = `[redacted:${name}]`;
      const pieces = [
        "",
        " ",
        "[",
        "]",
        ":",
        "x",
        marker,
        "[redacted:",
        value,
        escaped,
        `\\"abcdefg`,
      ];
      for (const left of pieces) {
        for (const right of pieces) {
          for (const form of [value, escaped]) {
            const text = `${left}${form}${right}`;
            const expected = redactEnvSecretsOnMain(text, env);
            if ([value, escaped].some((f) => expected.includes(f))) continue;
            // An escaped form that holds the raw form always holds a raw hit, so it adds no span.
            const spanForms = escaped.includes(value) ? [value] : [value, escaped];
            if (hasOverlappingOccurrences(text, spanForms)) continue;
            compared++;
            expect(redactEnvSecrets(text, env), JSON.stringify({ name, value, text })).toBe(
              expected,
            );
          }
        }
      }
    }
  }
  expect(compared).toBeGreaterThan(1000);
});

function hasOverlappingOccurrences(text, forms) {
  const spans = [];
  for (const form of new Set(forms)) {
    for (let i = text.indexOf(form); i >= 0; i = text.indexOf(form, i + 1)) {
      spans.push([i, i + form.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  return spans.some((span, i) => i > 0 && span[0] < spans[i - 1][1]);
}

// Usefulness: verifies the stated exceptions of ADR 0017: where the main output holds a complete value
// or a piece of a self-overlapping occurrence, the new output holds none (issue #521).
test("the only differences from the main output are where the main output leaks", () => {
  const rebuilt = { A_TOKENx: "x]abcdefg" };
  const boundary = "x]abcdefgabcdefg";
  expect(redactEnvSecretsOnMain(boundary, rebuilt)).toContain("x]abcdefg");
  expect(redactEnvSecrets(boundary, rebuilt)).not.toContain("x]abcdefg");

  const selfOverlap = { SELF_TOKEN: "abcabcabc" };
  expect(redactEnvSecretsOnMain("abcabcabcabc", selfOverlap)).toContain("abc");
  expect(redactEnvSecrets("abcabcabcabc", selfOverlap)).toBe("[redacted:SELF_TOKEN]");
});

// Usefulness: pins the third difference from the main output in ADR 0017: overlapping occurrences that the
// main output masks fully give one marker for the merged run, not one for each match (issue #521).
test("a tiled self-overlapping value gives one marker where main gives two", () => {
  const env = { S_TOKEN: "abcabcabc" };
  const text = "abcabcabcabcabcabc";
  expect(redactEnvSecretsOnMain(text, env)).toBe("[redacted:S_TOKEN][redacted:S_TOKEN]");
  const out = redactEnvSecrets(text, env);
  expect(out).toBe("[redacted:S_TOKEN]");
  expect(out).not.toContain("abc");
});

// Usefulness: verifies two variables with one value give the output of the main algorithm: the first
// variable in the environment owns the marker, and no value stays (issue #521).
test("two variables with the same value give the main output", () => {
  const env = { A_TOKEN: "synthetic-aaa", B_KEY: "synthetic-aaa" };
  const text = "x synthetic-aaa y";
  expect(redactEnvSecretsOnMain(text, env)).toBe("x [redacted:A_TOKEN] y");
  expect(redactEnvSecrets(text, env)).toBe("x [redacted:A_TOKEN] y");
});

// Usefulness: verifies the setup and the marker choice stay near-linear in the number of unique values,
// so an environment with many secret-named variables does not slow every redaction (issue #521). The
// check compares the best run time of 2,500 values with that of 40,000 values on a short text, so a slow
// runner does not change the verdict: the size ratio is 16, linear growth gives about 16 (measured 15 to
// 17), and quadratic growth gives about 256 (measured 160 to 220). The bound of 64 sits between them.
test("the redaction time grows near-linearly with the number of unique values", () => {
  const run = (count, attempts) => {
    const env = {};
    for (let i = 0; i < count; i++) {
      env[`VAR_${i}_TOKEN`] = `value-${i}-synthetic-secret`;
    }
    const text = "a short text with value-7-synthetic-secret and no other value";
    let best = Infinity;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const start = performance.now();
      const out = redactEnvSecrets(text, env);
      best = Math.min(best, performance.now() - start);
      expect(out).toBe("a short text with [redacted:VAR_7_TOKEN] and no other value");
    }
    return best;
  };
  run(1000, 2);
  const small = run(2500, 5);
  const large = run(40_000, 3);
  expect(large / small).toBeLessThan(64);
});

// Usefulness: pins the fourth difference from the main output in ADR 0017: a variable whose name holds the
// value of another variable. Main nests a marker in the marker, head prints `[*]`, and no value stays in
// either output (issue #521).
test("a variable name that holds another value gives [*] where main nests a marker", () => {
  const env = { LONG_SECRETVALUE_TOKEN: "synthetic-aaa-1", SHORT_KEY: "SECRETVALUE" };
  const text = "a synthetic-aaa-1 b";
  const onMain = redactEnvSecretsOnMain(text, env);
  expect(onMain).toBe("a [redacted:LONG_[redacted:SHORT_KEY]_TOKEN] b");
  const out = redactEnvSecrets(text, env);
  expect(out).toBe("a [*] b");
  for (const form of formsOf(env)) {
    expect(onMain).not.toContain(form);
    expect(out).not.toContain(form);
  }
});

// Usefulness: pins one more example of the difference that ADR 0017 states: the value of one variable
// occurs in the marker of another. Main nests a marker in the marker, head prints `[*]`, and no value
// stays in either output (issue #521).
test("a value that occurs in the marker of another variable gives [*] where main nests a marker", () => {
  const env = { A_TOKEN: "synthetic-aaa", B_KEY: "redacted:A" };
  const onMain = redactEnvSecretsOnMain("synthetic-aaa", env);
  expect(onMain).toBe("[[redacted:B_KEY]_TOKEN]");
  const out = redactEnvSecrets("synthetic-aaa", env);
  expect(out).toBe("[*]");
  for (const form of formsOf(env)) {
    expect(onMain).not.toContain(form);
    expect(out).not.toContain(form);
  }
});
