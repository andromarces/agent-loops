import { join } from "node:path";
import { execa } from "execa";
import { expect, test, vi } from "vite-plus/test";
import { runBatchMain } from "../../src/batch/cli.mjs";
import { setLogsToStderr } from "../../src/lib/log.mjs";
import { git } from "../../src/batch/git.mjs";
import { createTempRepo } from "../git-helpers.mjs";
import { removePath } from "../fs-helpers.mjs";

async function runQuiet(argv) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runBatchMain(argv);
    return {
      code,
      out: log.mock.calls.map((call) => call.join(" ")).join("\n"),
      err: error.mock.calls,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    setLogsToStderr(false);
  }
}

// Usefulness: a refused start exits 2 before any state write or child.
test("a refused start exits 2", async () => {
  const { code, out } = await runQuiet(["start", "--issue", "1"]);
  expect(code).toBe(2);
  expect(out).toBe("");
});

// Usefulness: a status read of an unknown batch is a usage refusal, not a crash.
test("status of an unknown batch exits 2", async () => {
  const { code } = await runQuiet(["status", "--batch", "no-such-batch"]);
  expect(code).toBe(2);
});

// Usefulness: resume requires the batch id.
test("resume without --batch exits 2", async () => {
  const { code } = await runQuiet(["resume"]);
  expect(code).toBe(2);
});

// Usefulness: an unknown batch command is refused.
test("an unknown batch command exits 2", async () => {
  const { code } = await runQuiet(["wat"]);
  expect(code).toBe(2);
});

// Usefulness: batch help prints the command surface.
test("batch help prints the commands and exit codes", async () => {
  const { code, out } = await runQuiet(["--help"]);
  expect(code).toBe(0);
  expect(out).toContain("agent-loop batch start");
  expect(out).toContain("agent-loop batch answer");
  expect(out).toContain("130");
});

// Usefulness: answer requires its three flags and does not reach the store without them.
test("answer without its flags exits 2", async () => {
  expect((await runQuiet(["answer"])).code).toBe(2);
  expect((await runQuiet(["answer", "--batch", "b1"])).code).toBe(2);
  expect((await runQuiet(["answer", "--batch", "b1", "--decision", "d1"])).code).toBe(2);
});

// Usefulness: answering an unknown decision writes nothing and exits nonzero.
test("answer of an unknown decision exits 2", async () => {
  const { code, out } = await runQuiet([
    "answer",
    "--batch",
    "no-such-batch",
    "--decision",
    "no-such-decision",
    "--option",
    "resume",
  ]);
  expect(code).toBe(2);
  expect(out).toBe("");
});

// Usefulness: an audit start with no settings is a usage refusal before any store or child.
test("an audit start with no settings exits 2", async () => {
  const { code, out } = await runQuiet(["audit", "start"]);
  expect(code).toBe(2);
  expect(out).toBe("");
});

// Usefulness: audit status needs a known id to be a usage refusal, not a crash.
test("audit status of an unknown audit exits 2", async () => {
  const { code } = await runQuiet(["audit", "status", "--audit", "no-such-audit"]);
  expect(code).toBe(2);
});

// Usefulness: an audit resume without an id is refused.
test("audit resume without --audit exits 2", async () => {
  const { code } = await runQuiet(["audit", "resume"]);
  expect(code).toBe(2);
});

// Usefulness: an unknown audit command is refused.
test("an unknown audit command exits 2", async () => {
  const { code } = await runQuiet(["audit", "wat"]);
  expect(code).toBe(2);
});

// Usefulness: remove needs one known audit id, so a missing or foreign id is a usage refusal
// rather than a removal of something else (ADR 0118).
test("audit remove requires a known audit id", async () => {
  expect((await runQuiet(["audit", "remove"])).code).toBe(2);
  const unknown = await runQuiet(["audit", "remove", "--audit", "no-such-audit"]);
  expect(unknown.code).toBe(2);
  expect(unknown.err.flat().join("\n")).toContain("No audit no-such-audit");
});

// Usefulness: audit help prints the command surface and the exit codes.
test("audit help prints the commands and exit codes", async () => {
  const { code, out } = await runQuiet(["audit", "--help"]);
  expect(code).toBe(0);
  expect(out).toContain("agent-loop batch audit start");
  expect(out).toContain("agent-loop batch audit remove");
  expect(out).toContain("130");
});
// Usefulness: decision 8 keeps checkpoints outside any repository, so a runs root inside the
// target work tree is refused before any state write.
test("a runs root inside the repository is refused before any write", async () => {
  const main = await createTempRepo();
  const remote = `${main}-remote`;
  const base = (await git(["rev-parse", "--abbrev-ref", "HEAD"], main)).stdout;
  const previous = process.env.AGENT_LOOP_RUNS_ROOT;
  try {
    await execa("git", ["init", "--bare", remote]);
    await execa("git", ["remote", "add", "origin", remote], { cwd: main });
    await execa("git", ["push", "-u", "origin", base], { cwd: main });
    await execa("git", ["update-ref", `refs/remotes/origin/${base}`, "HEAD"], { cwd: main });
    await execa(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${base}`],
      {
        cwd: main,
      },
    );
    process.env.AGENT_LOOP_RUNS_ROOT = join(main, "runs");
    const { code } = await runQuiet([
      "start",
      "--repo",
      main,
      "--issue",
      "1",
      "--orchestrator",
      "codex",
      "--worker",
      "claude",
      "--reviewer",
      "agy",
      "--loops",
      "1",
      "--max-steps",
      "2",
    ]);
    expect(code).toBe(2);
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(join(main, "runs"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.AGENT_LOOP_RUNS_ROOT;
    else process.env.AGENT_LOOP_RUNS_ROOT = previous;
    await removePath(remote);
    await removePath(main);
  }
});
