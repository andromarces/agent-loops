import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sha256 } from "../src/lib/hash.mjs";
import { statePaths } from "../src/lib/runstate.mjs";
import { executeRoleCommand, main as runRoleMain } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  spyStdoutWrite,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Interactive behavior of `--test-cmd` (issue #420, ADR 0017).
const node = (body) => `node -e "${body}"`;
// Synthetic value for the secret-named environment variable of the redaction test.
const SYNTHETIC_SECRET = "synthetic-probe-value-8f3a1c";
// A command that leaves a marker file, so a test can tell which command ran.
const marker = (file) =>
  node(`require('fs').writeFileSync('${file.replaceAll("\\", "/")}', 'ran')`);
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const scratch = [];
async function scratchDir() {
  const dir = await mkdtemp(join(tmpdir(), "role-test-cmd-"));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await removePath(dir);
  }
});

async function start(extra = []) {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const init = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, ...extra], "worker"), repo),
    { agents, stdin: stdinPrompt },
  );
  return { repo, reviewer, agents, init };
}

const reviewerTurn = (repo, agents, overrides = []) =>
  executeRoleCommand(withRepo(dispatchArgv(overrides, "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
  });

// Usefulness: verifies the init call records only a digest of the command and
// its bound, so a later dispatch can check the flag against it and the state file
// never holds the command text (issue #420, ADR 0017).
test("init records a digest of the test command and its bound, not the command", async () => {
  const { repo, init } = await start([
    "--test-cmd",
    "pnpm test --token-ish",
    "--test-cmd-timeout",
    "90",
  ]);
  expect(init.exitCode).toBe(0);
  const state = await readRepoState(repo);
  expect(state.testCmdTimeout).toBe(90);
  expect(state.testCmdSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(state)).not.toContain("pnpm test");
});

// Usefulness: verifies a run with no `--test-cmd` writes none of the fields, so
// the state file keeps the shape a consumer already reads (issue #420).
test("a run without --test-cmd records no test command fields", async () => {
  const { repo } = await start();
  const state = await readRepoState(repo);
  expect(state).not.toHaveProperty("testCmdSha256");
  expect(state).not.toHaveProperty("testCmdTimeout");
});

// Usefulness: verifies a reviewer dispatch that passes the flag runs that
// command, supplies the result in the prompt, and reports it in the envelope and
// the state file, so the parent can compare it with the reviewer Checks line
// (issue #420).
test("a reviewer dispatch supplies the test result in the prompt, envelope, and state", async () => {
  const cmd = node("console.log('5 passed')");
  const { repo, reviewer, agents } = await start(["--test-cmd", cmd]);
  const turn = await reviewerTurn(repo, agents, ["--test-cmd", cmd]);
  expect(turn.exitCode).toBe(0);
  expect(reviewer.recorded[0].prompt).toContain("5 passed");
  expect(reviewer.recorded[0].prompt).toContain("Result: exit 0.");
  expect(turn.payload.testRun).toMatchObject({ status: "pass", exitCode: 0, advisory: true });
  expect((await readRepoState(repo)).lastResult.testRun).toMatchObject({ status: "pass" });
});

// Usefulness: verifies the operator flag is the only source of the command on a
// later dispatch: a command written into the state file by something else, as a
// plain field or with a digest that matches it, never runs (issue #420, ADR 0017).
test("a command substituted in the state file never runs", async () => {
  const dir = await scratchDir();
  const operator = join(dir, "operator.txt");
  const substitute = join(dir, "substitute.txt");
  const { repo, agents } = await start(["--test-cmd", marker(operator)]);

  const stateFile = statePaths({ cwd: repo }).stateFile;
  const state = await readRepoState(repo);
  // Both shapes a turn could write: the plain field a reader might trust, and a
  // digest that matches the substitute.
  state.testCmd = marker(substitute);
  state.testCmdSha256 = sha256(marker(substitute));
  await writeFile(stateFile, JSON.stringify(state));

  const withFlag = await reviewerTurn(repo, agents, ["--test-cmd", marker(operator)]);
  expect(withFlag.exitCode).toBe(1);
  expect(withFlag.payload.error).toContain("--test-cmd cannot be changed after init");
  const withoutFlag = await reviewerTurn(repo, agents);
  expect(withoutFlag.exitCode).toBe(1);
  expect(await exists(substitute)).toBe(false);
  expect(await exists(operator)).toBe(false);
});

// Usefulness: verifies a reviewer dispatch with no flag on a run that set one is
// refused before it charges a step, so no path runs a command the flag did not
// name, including a resume (issue #420, ADR 0017).
test("a reviewer dispatch without the flag is refused and charges no step", async () => {
  const dir = await scratchDir();
  const operator = join(dir, "operator.txt");
  const { repo, agents } = await start(["--test-cmd", marker(operator)]);
  const before = (await readRepoState(repo)).stepsUsed;
  const turn = await reviewerTurn(repo, agents);
  expect(turn.exitCode).toBe(1);
  expect(turn.payload.error).toContain("--test-cmd is required");
  expect((await readRepoState(repo)).stepsUsed).toBe(before);
  expect(await exists(operator)).toBe(false);
});

// Usefulness: verifies a resumed interrupted run takes the command from the flag
// as well: the resume dispatch runs the flag command and ignores a substituted
// state field (issue #420, ADR 0017).
test("a resumed dispatch runs the flag command and not a state field", async () => {
  const dir = await scratchDir();
  const operator = join(dir, "operator.txt");
  const substitute = join(dir, "substitute.txt");
  const { repo, agents } = await start(["--test-cmd", marker(operator)]);
  const stateFile = statePaths({ cwd: repo }).stateFile;
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  state.testCmd = marker(substitute);
  await writeFile(stateFile, JSON.stringify(state));

  const resumed = await reviewerTurn(repo, agents, [
    "--resume-interrupted",
    "--test-cmd",
    marker(operator),
  ]);
  expect(resumed.exitCode).toBe(0);
  expect(await readFile(operator, "utf8")).toBe("ran");
  expect(await exists(substitute)).toBe(false);
});

// Usefulness: verifies a worker dispatch runs no command and carries no result,
// because the command belongs to reviewer turns only (issue #420).
test("a worker dispatch runs no test command", async () => {
  const cmd = node("console.log('ran')");
  const { repo, agents } = await start(["--test-cmd", cmd]);
  const state = await readRepoState(repo);
  expect(state.lastResult).not.toHaveProperty("testRun");
  const second = await executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.payload).not.toHaveProperty("testRun");
});

// Usefulness: verifies a timed-out command reports as timed out in the envelope
// and the turn still completes, so a slow suite does not end the run (issue #420).
test("a timed-out command is reported in the envelope and the turn completes", async () => {
  const cmd = node("setTimeout(() => {}, 60000)");
  const { repo, agents } = await start(["--test-cmd", cmd, "--test-cmd-timeout", "1"]);
  const turn = await reviewerTurn(repo, agents, ["--test-cmd", cmd]);
  expect(turn.exitCode).toBe(0);
  expect(turn.payload.testRun).toMatchObject({ status: "timed-out", timedOut: true });
}, 20_000);

// Usefulness: verifies a later call cannot change or add the command, so only
// the init flag sets it, and the refusal never prints the stored command
// (issue #420, ADR 0017).
test("a later call rejects a changed or added test command", async () => {
  const { repo, agents } = await start(["--test-cmd", "pnpm test"]);
  const changed = await reviewerTurn(repo, agents, ["--test-cmd", "rm -rf /"]);
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--test-cmd cannot be changed after init");
  expect(changed.payload.error).not.toContain("pnpm test");

  const plain = await start();
  const added = await reviewerTurn(plain.repo, plain.agents, ["--test-cmd", "pnpm test"]);
  expect(added.payload.error).toContain("--test-cmd cannot be changed after init");
});

// Usefulness: verifies a reviewer turn that ends in an adapter error still
// reports the command result and its work tree change in the envelope and the
// state file, so a failed turn does not lose evidence the runtime already read
// (issue #420, ADR 0017).
test("an adapter error keeps the test result in the envelope and the state", async () => {
  const cmd = node("require('fs').writeFileSync('generated.txt', 'x'); console.log('9 passed')");
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const failing = {
    async run() {
      throw new Error("reviewer CLI crashed");
    },
  };
  const agents = { fake1: recordingAdapter([]), fake2: failing };
  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--test-cmd", cmd], "worker"), repo),
    { agents, stdin: stdinPrompt },
  );
  const turn = await reviewerTurn(repo, agents, ["--test-cmd", cmd]);
  expect(turn.exitCode).toBe(1);
  expect(turn.payload).toMatchObject({ status: "error" });
  expect(turn.payload.testRun).toMatchObject({
    status: "pass",
    workTreeChanged: true,
    changedPaths: ["generated.txt"],
  });
  expect((await readRepoState(repo)).lastResult.testRun).toMatchObject({ status: "pass" });
});

// Usefulness: verifies init refuses a bound with no command and a blank command,
// so a run never starts with a half-set pair (issue #420).
test("init refuses a bound without a command and a blank command", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const deps = { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) } };
  for (const [extra, message] of [
    [["--test-cmd-timeout", "5"], "--test-cmd-timeout requires --test-cmd."],
    [["--test-cmd", "  "], "--test-cmd must not be blank."],
  ]) {
    const result = await executeRoleCommand(
      withRepo(dispatchArgv([...INIT_OVERRIDES, ...extra], "worker"), repo),
      { ...deps, stdin: stdinPrompt },
    );
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain(message);
  }
});

// Usefulness: verifies an interactive cancel during the command keeps the result and the
// work tree compare in the envelope and the state file, so the parent sees what the
// command wrote before the cancel (issue #420 review of aa0b25e).
test("a cancel during the command keeps the test result in the envelope and the state", async () => {
  const dir = await scratchDir();
  const started = join(dir, "started.txt");
  const cmd = node(
    `require('fs').writeFileSync('early.txt', 'x'); require('fs').writeFileSync('${started.replaceAll("\\", "/")}', 'y'); setTimeout(() => {}, 60000)`,
  );
  const { repo, agents } = await start(["--test-cmd", cmd]);
  const controller = new AbortController();
  const pending = executeRoleCommand(
    withRepo(dispatchArgv(["--test-cmd", cmd], "reviewer"), repo),
    { agents, stdin: stdinPrompt, signal: controller.signal },
  );
  const deadline = Date.now() + 10_000;
  while (!(await exists(started))) {
    expect(Date.now() < deadline, "the command never started").toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  const turn = await pending;
  expect(turn.exitCode).toBe(130);
  expect(turn.payload.testRun).toMatchObject({
    status: "canceled",
    workTreeChanged: true,
    changedPaths: ["early.txt"],
  });
  expect((await readRepoState(repo)).lastResult.testRun).toMatchObject({ status: "canceled" });
}, 20_000);

// Error objects that cannot take the `testRun` property the runtime attaches to a fatal error.
const UNATTACHABLE = [
  ["frozen", (props) => Object.freeze(Object.assign(new Error("stopped"), props))],
  [
    "throwing setter",
    (props) =>
      Object.defineProperty(Object.assign(new Error("stopped"), props), "testRun", {
        set() {
          throw new Error("setter failed");
        },
      }),
  ],
];

// Usefulness: verifies a canceled error that cannot take the test result still ends the turn as
// an interrupted cancel and keeps the result in the envelope and lastResult (ADR 0017 decision 10).
test.each(UNATTACHABLE)(
  "a %s canceled error keeps the cancel and the test result after the command ran",
  async (_label, makeError) => {
    const cmd = node("console.log('ok')");
    const { repo, agents } = await start(["--test-cmd", cmd]);
    agents.fake2 = {
      async run() {
        throw makeError({ isCanceled: true });
      },
    };
    const turn = await reviewerTurn(repo, agents, ["--test-cmd", cmd]);
    expect(turn.exitCode).toBe(130);
    expect(turn.payload).toMatchObject({ role: "reviewer", status: "error", error: "stopped" });
    expect(turn.payload.testRun).toMatchObject({ status: "pass", exitCode: 0 });
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("interrupted");
    expect(state.lastResult.testRun).toMatchObject({ status: "pass" });
  },
);

// Usefulness: verifies a command text that holds the value of a secret-named environment
// variable reaches the reviewer prompt, the envelope, the state file, and the error text of
// a refused dispatch as `[redacted:NAME]`, on a completed turn and on an adapter error
// (issue #431, ADR 0017).
test("a secret value in the command text is redacted on every interactive output path", async () => {
  process.env.SYNTH_PROBE_TOKEN = SYNTHETIC_SECRET;
  try {
    const cmd = `${node("console.log('ok')")} ${SYNTHETIC_SECRET}`;
    const { repo, reviewer, agents, init } = await start(["--test-cmd", cmd]);
    expect(JSON.stringify(init.payload)).not.toContain(SYNTHETIC_SECRET);
    const turn = await reviewerTurn(repo, agents, ["--test-cmd", cmd]);
    const refused = await reviewerTurn(repo, agents, ["--test-cmd", `${cmd} changed`]);
    expect(refused.exitCode).toBe(1);

    const failing = {
      async run() {
        throw new Error("reviewer CLI crashed");
      },
    };
    const failed = await reviewerTurn(repo, { ...agents, fake2: failing }, ["--test-cmd", cmd]);
    expect(failed.exitCode).toBe(1);

    const outputs = {
      prompt: reviewer.recorded[0].prompt,
      envelope: JSON.stringify(turn.payload),
      errorEnvelope: JSON.stringify(failed.payload),
      refusal: JSON.stringify(refused.payload),
      state: JSON.stringify(await readRepoState(repo)),
    };
    expect(outputs.prompt).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(outputs.envelope).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(outputs.errorEnvelope).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    for (const text of Object.values(outputs)) {
      expect(text).not.toContain(SYNTHETIC_SECRET);
    }
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
  }
});

// Usefulness: verifies each interactive refusal that echoes an argument prints a secret-named
// environment value as `[redacted:NAME]` in the envelope on stdout: parser refusals, an init
// refusal, a changed or missing --test-cmd, and an adapter error (issue #431, ADR 0017).
test.each([
  ["an unknown flag with a value", ["--bogus=SECRET"]],
  ["a stray argument from an unquoted command", ["--test-cmd", "node", "SECRET"]],
  ["a bad --role value", ["--role=SECRET"]],
  ["a bad --mode value", ["--mode=SECRET"]],
  [
    "a malformed --test-cmd-timeout beside the command",
    ["--test-cmd", "echo SECRET", "--test-cmd-timeout=SECRET"],
  ],
  ["an unsupported worker at init", ["--worker=SECRET"]],
])("an interactive refusal for %s redacts the secret", async (_name, extra) => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const origExitCode = process.exitCode;
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const synthetic = "synthetic-probe-value-8f3a1c";
  process.env.SYNTH_PROBE_TOKEN = synthetic;
  try {
    const argv = [...dispatchArgv(INIT_OVERRIDES, "worker"), ...extra].map((arg) =>
      arg === "<repo>" ? repo : arg.replaceAll("SECRET", synthetic),
    );
    await runRoleMain(argv, {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    });
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(printed).status).toBe("error");
    expect(printed).not.toContain(synthetic);
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain(synthetic);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies an adapter error whose text holds a secret-named environment value reaches
// the envelope and the state file as `[redacted:NAME]` (issue #431, ADR 0017).
test("an adapter error text redacts a secret value in the envelope and the state", async () => {
  process.env.SYNTH_PROBE_TOKEN = SYNTHETIC_SECRET;
  try {
    const cmd = node("console.log('ok')");
    const { repo, agents } = await start(["--test-cmd", cmd]);
    const failing = {
      async run() {
        throw new Error(`reviewer CLI crashed near ${SYNTHETIC_SECRET}`);
      },
    };
    const failed = await reviewerTurn(repo, { ...agents, fake2: failing }, ["--test-cmd", cmd]);
    expect(failed.payload.error).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    const state = JSON.stringify(await readRepoState(repo));
    expect(state).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    for (const text of [JSON.stringify(failed.payload), state]) {
      expect(text).not.toContain(SYNTHETIC_SECRET);
    }
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
  }
});

// Usefulness: verifies a missing --test-cmd on a later dispatch of a run that set one is refused
// without printing the command, so the refusal path never echoes a stored or supplied value.
test("a missing or changed --test-cmd refusal never prints the command", async () => {
  process.env.SYNTH_PROBE_TOKEN = SYNTHETIC_SECRET;
  try {
    const cmd = `${node("console.log('ok')")} ${SYNTHETIC_SECRET}`;
    const { repo, agents } = await start(["--test-cmd", cmd]);
    const missing = await reviewerTurn(repo, agents);
    const changed = await reviewerTurn(repo, agents, ["--test-cmd", `${cmd} changed`]);
    for (const turn of [missing, changed]) {
      expect(turn.exitCode).toBe(1);
      expect(JSON.stringify(turn.payload)).not.toContain(SYNTHETIC_SECRET);
    }
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
  }
});

// Usefulness: verifies a thrown value whose message is not a string, or that is not an Error,
// reaches the interactive envelope and the state file with a secret-named environment value
// redacted, so a non-string message cannot bypass the shared sink (issue #431, ADR 0017).
test.each([
  ["an object message", () => ({ message: { detail: SYNTHETIC_SECRET } })],
  ["an array message", () => ({ message: [SYNTHETIC_SECRET] })],
  ["a thrown string", () => SYNTHETIC_SECRET],
])("a thrown value with %s is redacted in the envelope and the state", async (_name, make) => {
  process.env.SYNTH_PROBE_TOKEN = SYNTHETIC_SECRET;
  try {
    const cmd = node("console.log('ok')");
    const { repo, agents } = await start(["--test-cmd", cmd]);
    const failing = {
      async run() {
        throw make();
      },
    };
    const failed = await reviewerTurn(repo, { ...agents, fake2: failing }, ["--test-cmd", cmd]);
    expect(failed.exitCode).toBe(1);
    const state = JSON.stringify(await readRepoState(repo));
    for (const text of [JSON.stringify(failed.payload), state]) {
      expect(text).toContain("[redacted:SYNTH_PROBE_TOKEN]");
      expect(text).not.toContain(SYNTHETIC_SECRET);
    }
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
  }
});

// Usefulness: verifies the transcript append warning and the stdout failure warning print a
// secret-named environment value as `[redacted:NAME]`, because both print an error value or a
// path directly (issue #431, ADR 0017).
test("the role transcript and stdout failure warnings redact a secret value", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const origExitCode = process.exitCode;
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.SYNTH_PROBE_TOKEN = SYNTHETIC_SECRET;
  try {
    const dir = await scratchDir();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = { fake1: recordingAdapter([]), fake2: recordingAdapter([]) };
    const argv = [
      "dispatch",
      "--role",
      "worker",
      "--cwd",
      repo,
      ...INIT_OVERRIDES,
      "--prompt-file",
      promptFile,
      "--transcript",
      join(blocker, SYNTHETIC_SECRET, "t.jsonl"),
    ];
    const writeSpy = spyStdoutWrite({
      failure: new Error(`write failed near ${SYNTHETIC_SECRET}`),
    });
    try {
      await runRoleMain(argv, { agents });
    } finally {
      writeSpy.mockRestore();
    }
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("Failed to append transcript");
    expect(logged).toContain("Failed to write the envelope to stdout");
    expect(logged).toContain("[redacted:SYNTH_PROBE_TOKEN]");
    expect(logged).not.toContain(SYNTHETIC_SECRET);
  } finally {
    delete process.env.SYNTH_PROBE_TOKEN;
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});
