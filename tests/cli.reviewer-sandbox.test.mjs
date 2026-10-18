import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";
import { main } from "../src/cli.mjs";
import { createTempRepo, removePath } from "./runtime-helpers.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

// Headless behavior of the Codex reviewer sandbox mode (issue #776, ADR 0038). The reviewer is a
// recording fake that stands for Codex by its kind, so the assertions read the mode input it got.

const ARGS = [
  "--orchestrator",
  "claude",
  "--worker",
  "agy",
  "--reviewer",
  "codex",
  "--task",
  "long task",
];
const REVIEW = JSON.stringify({ action: "run_reviewer", prompt: "r" });
const FINISH = JSON.stringify({
  action: "finish",
  summary: { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" },
});

// `seen` collects the reviewer turns. Each fake assigns a session id on its first call.
function agents(orchReplies, seen = []) {
  let call = 0;
  return {
    claude: {
      async run(state) {
        state.sessionId ??= "claude-session";
        return orchReplies[call++];
      },
    },
    agy: {
      async run(state) {
        state.sessionId ??= "agy-session";
        return "worker ok";
      },
    },
    codex: {
      async run(state, prompt, options) {
        state.sessionId ??= "codex-session";
        seen.push({ prompt, sandbox: options.sandbox, readOnly: options.readOnly });
        return "reviewer ok";
      },
    },
  };
}

let paths = [];
const exitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  await Promise.all(paths.map(removePath));
  paths = [];
});

async function workspace() {
  const repo = await createTempRepo();
  const out = await mkdtemp(join(tmpdir(), "reviewer-sandbox-"));
  paths.push(repo, out);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { repo, transcript: join(out, "run.json"), errors };
}

// One reviewer turn, then the step limit, so the transcript is resumable.
const firstRun = async (flags = []) => {
  const ws = await workspace();
  const seen = [];
  await main(
    [...ARGS, ...flags, "--cwd", ws.repo, "--max-steps", "1", "--transcript", ws.transcript],
    agents([REVIEW, REVIEW], seen),
  );
  return { ...ws, seen };
};

const readTranscript = async (path) => JSON.parse(await readFile(path, "utf8"));

// Usefulness: verifies a headless run with no flag gives the Codex reviewer no sandbox, passes the
// mode with readOnly kept, and records it in the transcript options (ADR 0038).
test("a new run without the flag runs the reviewer with no sandbox and records none", async () => {
  const { seen, transcript } = await firstRun();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ sandbox: "none", readOnly: true });
  expect(seen[0].prompt).toContain("no sandbox");
  expect((await readTranscript(transcript)).options.reviewerSandbox).toBe("none");
});

// Usefulness: verifies each flag mode and the alias reach the reviewer turn and the transcript.
test.each([
  [["--reviewer-sandbox", "read-only"], "read-only"],
  [["--reviewer-sandbox", "workspace-write"], "workspace-write"],
  [["--reviewer-workspace-write"], "workspace-write"],
])("%j runs the reviewer in %s and records it", async (flags, mode) => {
  const { seen, transcript } = await firstRun(flags);
  expect(seen[0]).toMatchObject({ sandbox: mode, readOnly: true });
  expect((await readTranscript(transcript)).options.reviewerSandbox).toBe(mode);
});

// Usefulness: verifies a continued run keeps the earlier mode when the flag is omitted or repeated,
// so a resume never changes the sandbox of the run (ADR 0038).
test.each([
  ["none", []],
  ["read-only", ["--reviewer-sandbox", "read-only"]],
  ["workspace-write", ["--reviewer-sandbox", "workspace-write"]],
])("--continue-from keeps the %s mode of the earlier run", async (mode, flags) => {
  const { repo, transcript } = await firstRun(flags);
  for (const again of [[], flags]) {
    const seen = [];
    await main(
      [...ARGS, ...again, "--cwd", repo, "--continue-from", transcript, "--max-steps", "3"],
      agents([REVIEW, FINISH], seen),
    );
    expect(process.exitCode).toBe(0);
    expect(seen[0].sandbox).toBe(mode);
  }
});

// Usefulness: verifies a continued run that names another mode is refused before any turn, in both
// directions, and that the refusal leaves the earlier transcript unchanged (ADR 0038).
test.each([
  [[], ["--reviewer-sandbox", "read-only"], "none"],
  [[], ["--reviewer-workspace-write"], "none"],
  [["--reviewer-sandbox", "read-only"], ["--reviewer-sandbox", "workspace-write"], "read-only"],
  [
    ["--reviewer-sandbox", "workspace-write"],
    ["--reviewer-sandbox", "read-only"],
    "workspace-write",
  ],
])("--continue-from after %j refuses %j", async (first, later, held) => {
  const { repo, transcript, errors } = await firstRun(first);
  const before = await readFile(transcript, "utf8");
  const seen = [];
  await main(
    [...ARGS, ...later, "--cwd", repo, "--continue-from", transcript, "--transcript", transcript],
    agents([FINISH], seen),
  );
  expect(process.exitCode).toBe(1);
  expect(errors.mock.calls.flat().join("\n")).toContain(
    `--reviewer-sandbox cannot be changed by --continue-from (the earlier run held: ${held}).`,
  );
  expect(seen).toEqual([]);
  expect(await readFile(transcript, "utf8")).toBe(before);
});

// Usefulness: verifies a transcript from before ADR 0038 never loses its sandbox: it gets
// `workspace-write` with the legacy field and `read-only` without it, never `none`.
test.each([
  [{ reviewerWorkspaceWrite: true }, "workspace-write"],
  [{}, "read-only"],
])("--continue-from a transcript with no recorded mode and %j runs in %s", async (legacy, mode) => {
  const { repo, transcript } = await firstRun();
  const earlier = await readTranscript(transcript);
  delete earlier.options.reviewerSandbox;
  Object.assign(earlier.options, legacy);
  await writeFile(transcript, JSON.stringify(earlier));

  const seen = [];
  await main(
    [
      ...ARGS,
      "--cwd",
      repo,
      "--continue-from",
      transcript,
      "--max-steps",
      "3",
      "--transcript",
      transcript,
    ],
    agents([REVIEW, FINISH], seen),
  );
  expect(process.exitCode).toBe(0);
  expect(seen[0].sandbox).toBe(mode);
  expect((await readTranscript(transcript)).options.reviewerSandbox).toBe(mode);
});

// Usefulness: verifies a recorded mode that is present but not one of the three is refused on
// --continue-from, for every kind of bad value, before any turn and with the transcript unchanged.
// It is never read as the legacy fallback, so it cannot bypass the change refusal (ADR 0038).
test.each([null, 0, 1, "", "full", "danger-full-access", true, {}])(
  "--continue-from refuses the recorded mode %j and names the field",
  async (value) => {
    const { repo, transcript, errors } = await firstRun();
    const earlier = await readTranscript(transcript);
    earlier.options.reviewerSandbox = value;
    await writeFile(transcript, JSON.stringify(earlier));
    const before = await readFile(transcript, "utf8");

    const seen = [];
    for (const flags of [[], ["--reviewer-sandbox", "read-only"]]) {
      errors.mockClear();
      await main(
        [
          ...ARGS,
          ...flags,
          "--cwd",
          repo,
          "--continue-from",
          transcript,
          "--transcript",
          transcript,
        ],
        agents([FINISH], seen),
      );
      expect(process.exitCode).toBe(1);
      expect(errors.mock.calls.flat().join("\n")).toContain(
        "has an invalid reviewerSandbox option",
      );
    }
    expect(seen).toEqual([]);
    expect(await readFile(transcript, "utf8")).toBe(before);
  },
);

// Usefulness: verifies the refusal does not depend on the reviewer kind, the same as the state file
// of the interactive path: a transcript of a reviewer that is not Codex never records the field.
test("--continue-from refuses an invalid recorded mode for a reviewer that is not Codex too", async () => {
  const ws = await workspace();
  const args = ARGS.map((v) => (v === "codex" ? "agy" : v));
  await main(
    [...args, "--cwd", ws.repo, "--max-steps", "1", "--transcript", ws.transcript],
    agents([REVIEW, REVIEW]),
  );
  const earlier = await readTranscript(ws.transcript);
  earlier.options.reviewerSandbox = null;
  await writeFile(ws.transcript, JSON.stringify(earlier));

  await main(
    [...args, "--cwd", ws.repo, "--continue-from", ws.transcript, "--max-steps", "3"],
    agents([FINISH]),
  );
  expect(process.exitCode).toBe(1);
  expect(ws.errors.mock.calls.flat().join("\n")).toContain("has an invalid reviewerSandbox option");
});
