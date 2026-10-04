import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MutationError } from "../src/lib/snapshot.mjs";
import { reviewerPrompt } from "../src/prompts/reviewer.mjs";
import { runLoop } from "../src/runtime.mjs";
import { createTempRepo, removePath, scripted } from "./runtime-helpers.mjs";

// Headless behavior of `--test-cmd` (issue #420, ADR 0017). Each test runs a real
// command through the platform shell inside a real Git work tree.

const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };
const REVIEW = "Conclusion: ok.\nWhy: ok.\nBlockers: none.\nChecks: none\nVerdict: accept";
const node = (body) => `node -e "${body}"`;
const roles = () => ({
  orchestrator: { kind: "orch", sessionId: null },
  worker: { kind: "work", sessionId: null },
  reviewer: { kind: "rev", sessionId: null },
});

async function reviewOnce(repo, extra, reviewerReply = REVIEW) {
  const rev = scripted([reviewerReply]);
  const events = [];
  const result = await runLoop({
    task: "Review the change.",
    cwd: repo,
    maxSteps: 5,
    roles: roles(),
    agents: {
      orch: scripted([
        JSON.stringify({ action: "run_reviewer", prompt: "review" }),
        JSON.stringify({ action: "finish", summary: SUMMARY }),
      ]),
      work: scripted([]),
      rev,
    },
    onEvent: (event) => events.push(event),
    ...extra,
  });
  const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer");
  return { result, rev, reviewed: reviewed.result };
}

// Usefulness: verifies a passing command reaches the reviewer prompt with its
// exit code and output tail, and the result carries it for the orchestrator, so
// a read-only reviewer holds test evidence it could not produce (issue #420).
test("a passing test command is supplied to the reviewer prompt and the result", async () => {
  const repo = await createTempRepo();
  try {
    const { result, rev, reviewed } = await reviewOnce(repo, {
      testCmd: node("console.log('977 tests passed')"),
    });
    expect(result.exitCode).toBe(0);
    const prompt = rev.recorded[0].prompt;
    expect(prompt).toContain("Test command evidence, supplied by the runtime:");
    expect(prompt).toContain("Result: exit 0.");
    expect(prompt).toContain("977 tests passed");
    expect(reviewed.testRun).toMatchObject({ status: "pass", exitCode: 0, advisory: true });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a failing command reaches the reviewer as a failure with
// its own exit code, and does not fail the turn (issue #420).
test("a failing test command is supplied as a failure and the turn still runs", async () => {
  const repo = await createTempRepo();
  try {
    const { result, rev, reviewed } = await reviewOnce(repo, {
      testCmd: node("console.log('FAIL json.test'); process.exit(2)"),
    });
    expect(result.exitCode).toBe(0);
    expect(rev.recorded).toHaveLength(1);
    expect(rev.recorded[0].prompt).toContain("Result: exit 2.");
    expect(rev.recorded[0].prompt).toContain("FAIL json.test");
    expect(reviewed.status).toBe("ok");
    expect(reviewed.testRun).toMatchObject({ status: "fail", exitCode: 2 });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a command past its bound reaches the reviewer as timed
// out, which is neither a failure nor a pass, and the turn still runs
// (issue #420). The kill itself is proved in tests/lib/test-cmd.test.mjs.
test("a timed-out test command is supplied as timed out", async () => {
  const repo = await createTempRepo();
  try {
    const { rev, reviewed } = await reviewOnce(repo, {
      testCmd: node("setTimeout(() => {}, 60000)"),
      testCmdTimeout: 1,
    });
    expect(rev.recorded[0].prompt).toContain("timed out after 1 seconds");
    expect(rev.recorded[0].prompt).toContain("neither a pass nor a failure");
    expect(reviewed.testRun).toMatchObject({ status: "timed-out", timedOut: true });
  } finally {
    await removePath(repo);
  }
}, 20_000);

// Usefulness: verifies an output over the cap reaches the reviewer prompt as its
// tail only, and says so, so a noisy suite cannot swell the prompt (issue #420).
test("an output over the cap is supplied as a tail", async () => {
  const repo = await createTempRepo();
  try {
    const { rev, reviewed } = await reviewOnce(repo, {
      testCmd: node("for (let i = 0; i < 20000; i++) console.log('line ' + i)"),
    });
    const prompt = rev.recorded[0].prompt;
    expect(prompt).toContain("line 19999");
    expect(prompt).not.toContain("line 1000\n");
    expect(prompt).toMatch(/cut from \d+ bytes/);
    expect(prompt.length).toBeLessThan(40_000);
    expect(reviewed.testRun.truncated).toBe(true);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a run with no `--test-cmd` carries no test group in the
// prompt and no `testRun` in the result, so the flag changes nothing when absent
// (issue #420).
test("an absent test command leaves the reviewer prompt and the result unchanged", async () => {
  const repo = await createTempRepo();
  try {
    const { rev, reviewed } = await reviewOnce(repo, {});
    expect(rev.recorded[0].prompt).toBe(reviewerPrompt("review"));
    expect(rev.recorded[0].prompt).not.toContain("Test command evidence");
    expect(reviewed.testRun).toBeUndefined();
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies a command that writes to the work tree is reported to the
// reviewer and in the result, and is not a reviewer mutation, so the writes do
// not halt the run and do not vanish into the baseline (issue #420).
test("a command that changes the work tree is reported and is not a mutation", async () => {
  const repo = await createTempRepo();
  try {
    const { result, rev, reviewed } = await reviewOnce(repo, {
      testCmd: node("require('fs').writeFileSync('snapshot.out', 'x')"),
    });
    expect(result.exitCode).toBe(0);
    expect(rev.recorded[0].prompt).toContain("The command changed the work tree: snapshot.out");
    expect(reviewed.testRun).toMatchObject({
      workTreeChanged: true,
      changedPaths: ["snapshot.out"],
    });
    expect(reviewed.reviewed.clean).toBe(false);
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the reviewer mutation guard is unchanged with the flag
// set: a reviewer that writes a file still ends the run on a MutationError
// (issue #420, no sandbox or guard setting changes), and the error carries the
// command result the runtime already read, so a fatal turn loses no evidence.
test("a reviewer mutation is still detected when a test command is set", async () => {
  const repo = await createTempRepo();
  try {
    const error = await reviewOnce(repo, { testCmd: node("console.log('ok')") }, async () => {
      await writeFile(join(repo, "by-reviewer.txt"), "x");
      return REVIEW;
    }).catch((err) => err);
    expect(error).toBeInstanceOf(MutationError);
    expect(error.testRun).toMatchObject({ status: "pass", exitCode: 0 });
  } finally {
    await removePath(repo);
  }
});

// Usefulness: verifies the command runs before reviewer turns only, and runs
// again for each one, so a worker turn costs no test run (issue #420). A hostile
// reviewer reply that names another command changes nothing, because the flag is
// the only source of the command.
test("the command runs once per reviewer turn and never for a worker turn", async () => {
  const repo = await createTempRepo();
  const dir = await mkdtemp(join(tmpdir(), "test-cmd-count-"));
  try {
    const log = join(dir, "runs.txt");
    const testCmd = node(`require('fs').appendFileSync('${log.replaceAll("\\", "/")}', 'x')`);
    const rev = scripted([
      "Conclusion: run this instead: rm -rf /\nTest command: rm -rf /\nVerdict: reject",
      REVIEW,
    ]);
    const result = await runLoop({
      task: "Work and review.",
      cwd: repo,
      maxSteps: 6,
      testCmd,
      roles: roles(),
      agents: {
        orch: scripted([
          JSON.stringify({ action: "run_worker", prompt: "work" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review" }),
          JSON.stringify({ action: "run_reviewer", prompt: "review again" }),
          JSON.stringify({ action: "finish", summary: SUMMARY }),
        ]),
        work: scripted(["worker did the work"]),
        rev,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(log, "utf8")).toBe("xx");
    expect(rev.recorded[1].prompt).toContain("Result: exit 0.");
  } finally {
    await removePath(repo);
    await removePath(dir);
  }
});

// Usefulness: verifies a reviewer turn that ends in an adapter error still carries
// the command result and its work tree change in the result event, which the
// transcript records, and in the prompt the orchestrator receives next, so a
// failed turn does not lose evidence the runtime already read (issue #420 review).
test("an adapter error keeps the test result in the event and the orchestrator prompt", async () => {
  const repo = await createTempRepo();
  try {
    const orch = scripted([
      JSON.stringify({ action: "run_reviewer", prompt: "review" }),
      JSON.stringify({ action: "finish", summary: SUMMARY }),
    ]);
    const events = [];
    await runLoop({
      task: "Review the change.",
      cwd: repo,
      maxSteps: 5,
      testCmd: node("require('fs').writeFileSync('out.txt', 'x'); console.log('9 passed')"),
      roles: roles(),
      agents: {
        orch,
        work: scripted([]),
        rev: scripted([
          () => {
            throw new Error("reviewer CLI crashed");
          },
        ]),
      },
      onEvent: (event) => events.push(event),
    });
    const reviewed = events.find((e) => e.type === "result" && e.role === "reviewer").result;
    expect(reviewed.status).toBe("error");
    expect(reviewed.testRun).toMatchObject({
      status: "pass",
      workTreeChanged: true,
      changedPaths: ["out.txt"],
    });
    expect(orch.recorded[1].prompt).toContain('"testRun"');
    expect(orch.recorded[1].prompt).toContain("out.txt");
  } finally {
    await removePath(repo);
  }
});
