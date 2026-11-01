import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `gitWhileDotGitExists` in git-helpers.mjs); every other test reaches the real `execa`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) =>
      gitDouble.answer
        ? gitDouble.answer(command, args, options)
        : real.execa(command, args, options),
  };
});

import { readState, statePaths, writeState } from "../src/lib/runstate.mjs";
import { reviewedState, snapshot } from "../src/lib/snapshot.mjs";
import { ProcessReadError } from "../src/lib/process-ancestry.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  REPORT,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo, gitWhileDotGitExists } from "./git-helpers.mjs";
import { PASSING_RUN, prGateGh } from "./gh-doubles.mjs";
import { createBarrierTest } from "./barrier-test.mjs";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

// A directory that `gitWhileDotGitExists` treats as a work tree. Callers remove it
// with `removePath`.
async function createDotGitDir() {
  const dir = await mkdtemp(join(tmpdir(), "role-dispatch-dotgit-"));
  await mkdir(join(dir, ".git"));
  return dir;
}

afterEach(async () => {
  gitDouble.answer = null;
  await cleanup();
});

// Usefulness: verifies acceptance — two consecutive worker dispatches resume
// the same worker session; the adapter receives the persisted session id on
// the second call.
test("two consecutive worker dispatches resume the same worker session", async () => {
  const repo = await newRunRepo();
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(first.exitCode).toBe(0);
  expect(first.payload).toMatchObject({
    role: "worker",
    status: "ok",
    report: { conclusion: "done", why: "tests pass", blockers: "none" },
  });

  const second = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(2);
  expect(worker.recorded[1].incomingSessionId).toBe("sess-1");

  const state = await readRepoState(repo);
  expect(state).toMatchObject({ stepsUsed: 2, lifecycle: "active" });
  expect(state.roles.worker.sessionId).toBe("sess-1");
});

// Usefulness: verifies acceptance — after an init call with --cwd set to a
// directory other than the process cwd, the session entry for --parent-session
// resolves to that run's state file through the shared helper.
test("session entry resolves a run dispatched into a different --cwd", async () => {
  const runsRoot = await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    ...basicDeps(),
  });

  const paths = statePaths({ cwd: repo, parentSession: "parent-sess-1" });
  expect(dirname(paths.sessionEntryFile)).toBe(join(runsRoot, "session-runs", "parent-sess-1"));
  // The entry holds the state file path; resolving it must reach the run that
  // was dispatched with --cwd pointing elsewhere.
  const stateFile = (await readFile(paths.sessionEntryFile, "utf8")).trim();
  expect(stateFile).toBe(paths.stateFile);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  expect(state).toMatchObject({ task: "Fix the flaky test.", cwd: repo });
});

// Usefulness: verifies acceptance — a worker dispatch under mode review-only
// exits non-zero and spawns no CLI.
test("review-only mode rejects a worker dispatch without spawning a CLI", async () => {
  const repo = await newRunRepo();

  const init = withRepo(
    dispatchArgv(
      [
        "--task",
        "Review only.",
        "--parent-session",
        "parent-sess-1",
        "--mode",
        "review-only",
        "--worker",
        "fake1",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  const state = await readRepoState(repo);
  expect(state.mode).toBe("review-only");

  const worker = recordingAdapter([]);
  const rejected = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents: { fake1: worker, fake2: worker },
    stdin: stdinPrompt,
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.payload.error).toContain("mode review-only rejects --role worker");
  expect(worker.recorded.length).toBe(0);
  expect((await readRepoState(repo)).stepsUsed).toBe(state.stepsUsed);
});

// Usefulness: verifies an init dispatch against a `--cwd` that does not exist, or
// that is not inside a Git work tree, is refused before it writes a run state, so
// a refused init leaves nothing behind that a later call could resume (issue #327).
test("an init dispatch on a refused --cwd writes no run state", async () => {
  const repo = await newRunRepo();
  const notARepo = await mkdtemp(join(tmpdir(), "role-test-plain-"));
  repos.push(notARepo);
  const removed = join(repo, "removed-work-tree");
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  for (const cwd of [removed, notARepo]) {
    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), cwd), {
      agents,
      stdin: stdinPrompt,
    });
    expect(result.exitCode, cwd).toBe(1);
    expect(result.payload, cwd).toMatchObject({ status: "error" });
    expect(result.payload.error, cwd).toContain("--cwd must be inside a Git work tree");
    expect(await readState(statePaths({ cwd }).stateFile), cwd).toBeNull();
  }
  expect(worker.recorded.length).toBe(0);
});

// Usefulness: verifies the `--cwd` guard does not refuse a Git work tree whose
// path contains spaces, which would otherwise block every run in such a work tree
// on both the init dispatch and a later one (issue #352).
test("a dispatch in a Git work tree whose path contains spaces is not refused", async () => {
  await setup();
  const parent = await mkdtemp(join(tmpdir(), "role test spaced parent-"));
  repos.push(parent);
  const source = await createTempRepo();
  repos.push(source);
  const repo = join(parent, "my work tree");
  await rename(source, repo);
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  for (const overrides of [INIT_OVERRIDES, []]) {
    const result = await executeRoleCommand(withRepo(dispatchArgv(overrides), repo), {
      agents,
      stdin: stdinPrompt,
    });
    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({ status: "ok" });
  }
  expect(worker.recorded.length).toBe(2);
});

// Usefulness: verifies a later dispatch at a live run's own `--cwd` is refused
// when that work tree stops being usable, once because the directory is gone and
// once because the Git metadata at an existing path is, so the turn neither
// charges a step nor changes the lifecycle of the run it belongs to. The refusal
// must reach the initialized run: the state file is named after the resolved
// `--cwd`, so a check against another path would read no state at all and prove
// nothing (issue #327).
//
// `git` is answered from memory, not spawned: two real repos cost this test the
// 15 s limit on a loaded Windows runner (issue #492). The double answers as a work
// tree only while the directory holds `.git`, so the refusal still follows from
// the work tree state on disk. The removed path fails as execa reports a missing
// `cwd` (no exit code, ENOENT), and the lost `.git` exits 128 as git does.
test("a later dispatch at the live run's own --cwd is refused and changes no run state", async () => {
  await setup();
  gitDouble.answer = gitWhileDotGitExists;
  const goneRepo = await createDotGitDir();
  repos.push(goneRepo);
  const brokenRepo = await createDotGitDir();
  repos.push(brokenRepo);
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  for (const repo of [goneRepo, brokenRepo]) {
    // The init copy of local files has no `git` answers in the double.
    const init = await executeRoleCommand(
      withRepo(dispatchArgv([...INIT_OVERRIDES, "--no-copy-local-files"]), repo),
      { agents, stdin: stdinPrompt },
    );
    expect(init.exitCode, repo).toBe(0);
  }
  // The worker's turn removed its work tree in one run, and in the other left the
  // path in place with no Git metadata at it, which a linked work tree with a
  // pruned gitdir also looks like.
  await removePath(goneRepo);
  await removePath(join(brokenRepo, ".git"));
  const before = [await readRepoState(goneRepo), await readRepoState(brokenRepo)];

  for (const [index, repo] of [goneRepo, brokenRepo].entries()) {
    const result = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
      agents,
      stdin: stdinPrompt,
    });
    expect(result.exitCode, repo).toBe(1);
    expect(result.payload, repo).toMatchObject({ status: "error" });
    expect(result.payload.error, repo).toContain("--cwd must be inside a Git work tree");
    const after = await readRepoState(repo);
    expect(after, repo).toEqual(before[index]);
  }
  // The two init turns ran, and no later dispatch reached a child.
  expect(worker.recorded.length).toBe(2);
});

// Usefulness: verifies acceptance — a later call that supplies --worker against
// the null worker of a review-only run is rejected as a change after init
// instead of throwing on the missing role.
test("a later --worker against a null review-only worker is rejected", async () => {
  const repo = await newRunRepo();

  const init = withRepo(
    dispatchArgv(
      [
        "--task",
        "Review only.",
        "--parent-session",
        "parent-sess-1",
        "--mode",
        "review-only",
        "--reviewer",
        "fake2",
      ],
      "reviewer",
    ),
    repo,
  );
  await executeRoleCommand(init, {
    agents: { fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "fake1"], "reviewer"), repo),
    {
      agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      stdin: stdinPrompt,
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("--worker cannot be changed after init");
});

// Usefulness: verifies acceptance — a dispatch past the step budget or in any
// terminal lifecycle exits non-zero and spawns no CLI.
test("dispatch past the step budget or in a terminal lifecycle is rejected", async () => {
  const repo = await newRunRepo();

  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };
  const first = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "1"]), repo),
    {
      agents,
      stdin: stdinPrompt,
    },
  );
  expect(first.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(1);

  const over = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(over.exitCode).toBe(1);
  expect(over.payload.error).toContain("Step budget exhausted");
  expect(worker.recorded.length).toBe(1);
  expect((await readRepoState(repo)).stepsUsed).toBe(1);

  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const terminal = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(terminal.exitCode).toBe(1);
  expect(terminal.payload.error).toContain("aborted");
  expect(worker.recorded.length).toBe(1);
});

// Usefulness: verifies the dispatch seam — the parsed verdict and report reach
// the payload, and the reviewer session id is recorded in state. Parser edge
// cases are unit-tested in tests/lib/report.test.mjs.
test("reviewer dispatch exposes the parsed verdict in the payload", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-9";
    return `${REPORT}\nVerdict: accept`;
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const args = withRepo(dispatchArgv([], "reviewer"), repo);
  const result = await executeRoleCommand(args, {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.verdict).toBe("accept");
  expect(result.payload.report).toEqual({
    conclusion: "done",
    why: "tests pass",
    blockers: "none",
    checks: null,
    notes: null,
    deferred: null,
  });

  const state = await readRepoState(repo);
  expect(state.roles.reviewer.sessionId).toBe("rev-9");
  expect(state.lastResult.status).toBe("ok");
});

// Usefulness: verifies the reviewer envelope and the state file carry the
// runtime-owned reviewed state, and that all four fields match the work tree as
// the turn starts — a clean tree at a real head (issue #217).
test("reviewer dispatch carries the runtime reviewed state in envelope and state", async () => {
  const repo = await newRunRepo();

  const reviewer = recordingAdapter([]);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const before = await snapshot(repo);
  const expected = reviewedState(before);

  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.reviewed).toMatchObject({
    head: expected.head,
    clean: true,
    exact: true,
  });
  expect(result.payload.reviewed.digest).toBe(expected.digest);
  expect(result.payload.reviewed.head).toMatch(/^[0-9a-f]{40}$/);

  const state = await readRepoState(repo);
  expect(state.lastResult.reviewed).toEqual(result.payload.reviewed);
});

// Usefulness: verifies a reviewer turn over a work tree with an uncommitted
// change reports clean: false, so the parent can reject PR work on a dirty tree
// (issue #217).
test("reviewer dispatch reports clean: false on an uncommitted work tree", async () => {
  const repo = await newRunRepo();

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  await writeFile(join(repo, "init.txt"), "uncommitted change\n");

  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.reviewed.clean).toBe(false);
  expect(result.payload.reviewed.exact).toBe(true);
});

// Usefulness: verifies --transcript appends one invocation and one result
// event per dispatched turn, in the headless event shape, accumulated across
// calls.
test("dispatch appends invocation and result events to the transcript", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  const transcriptPath = join(paths.stateDir, "transcript.jsonl");

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--transcript", transcriptPath]), repo),
    basicDeps(),
  );
  await executeRoleCommand(
    withRepo(dispatchArgv(["--transcript", transcriptPath]), repo),
    basicDeps(),
  );

  const events = (await readFile(transcriptPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => `${event.type}:${event.role}`)).toEqual([
    "invocation:worker",
    "result:worker",
    "invocation:worker",
    "result:worker",
  ]);
  for (const event of events) {
    expect(event.at).toEqual(expect.any(String));
    expect(event.stepsUsed).toEqual(expect.any(Number));
  }
});

// Usefulness: verifies --prompt-file feeds the child prompt instead of stdin.
test("dispatch reads the prompt from --prompt-file", async () => {
  const repo = await newRunRepo();
  const promptFile = join(repo, "prompt.txt");
  await writeFile(promptFile, "work from the file", "utf8");

  const worker = recordingAdapter([]);
  const args = withRepo(
    dispatchArgv([
      "--task",
      "Task.",
      "--parent-session",
      "parent-sess-1",
      "--worker",
      "fake1",
      "--reviewer",
      "fake2",
      "--prompt-file",
      promptFile,
    ]),
    repo,
  );
  await executeRoleCommand(args, { agents: { fake1: worker, fake2: recordingAdapter([]) } });
  expect(worker.recorded[0].prompt).toContain("work from the file");
});

// Usefulness: verifies an empty stdin prompt exits non-zero, charges no step,
// and spawns no CLI (regression: the empty check only covered --prompt-file).
test("empty stdin prompt is rejected without charging a step", async () => {
  const repo = await newRunRepo();

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const before = await readRepoState(repo);

  const worker = recordingAdapter([]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: async () => "   ",
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toContain("Prompt on stdin is empty");
  expect(worker.recorded.length).toBe(0);
  const after = await readRepoState(repo);
  expect(after.stepsUsed).toBe(before.stepsUsed);
  expect(after.lifecycle).toBe("active");
});

// Usefulness: verifies acceptance — the first call after a crash marks
// `interrupted`, exits non-zero, and spawns no child, even with an explicit
// `--resume-interrupted`; a maintainer can resume on a later call.
test("resume-interrupted from dispatched marks interrupted first and runs no child", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });

  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const state = await readState(paths.stateFile);
  state.lifecycle = "dispatched";
  await writeState(paths.stateFile, state);

  const worker = recordingAdapter([]);
  const direct = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(direct.exitCode).toBe(1);
  expect(direct.payload.status).toBe("error");
  expect(direct.payload.error).toContain("interrupted");
  expect(worker.recorded.length).toBe(0);
  expect((await readState(paths.stateFile)).lifecycle).toBe("interrupted");

  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(resumed.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(1);
  const resumedState = await readState(paths.stateFile);
  expect(resumedState.lifecycle).toBe("active");
  expect(resumedState.resumeDecision).toBeTruthy();
});

// Usefulness: verifies an init whose session entry write fails leaves a run that `--resume-interrupted` can still dispatch under `--max-steps 1`, which no other test covers because the other init failures write no state.
test("init whose session entry write fails keeps the step budget for a resume", async () => {
  const runsRoot = await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  // A file where the session entry directory belongs makes the entry write fail after the state write.
  await writeFile(join(runsRoot, "session-runs"), "not a directory", "utf8");

  const init = await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "1"]), repo),
    basicDeps(),
  );
  expect(init.exitCode).toBe(1);
  expect(init.payload.status).toBe("error");

  const worker = recordingAdapter([]);
  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(resumed.exitCode).toBe(0);
  expect(worker.recorded.length).toBe(1);
  expect(await readState(paths.stateFile)).toMatchObject({ stepsUsed: 1, maxSteps: 1 });
});

// Usefulness: verifies `--resume-interrupted` refuses a claude session that a live process holds, before the step is charged (#671, ADR 0031), which no other test covers.
test("resume-interrupted refuses a claude session that a live process holds", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  const heldId = "11111111-2222-4333-8444-555555555555";
  const worker = recordingAdapter([]);
  const deps = (processes) => ({
    agents: { claude: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    readProcessCommands: async () => processes,
  });

  await executeRoleCommand(
    withRepo(dispatchArgv(INIT_OVERRIDES.map((v) => (v === "fake1" ? "claude" : v))), repo),
    deps([]),
  );
  const state = await readState(paths.stateFile);
  state.lifecycle = "interrupted";
  state.roles.worker.sessionId = heldId;
  await writeState(paths.stateFile, state);
  const stepsBefore = state.stepsUsed;
  const recordedBefore = worker.recorded.length;

  const refused = await executeRoleCommand(
    withRepo(dispatchArgv(["--resume-interrupted"]), repo),
    deps([{ pid: 4242, command: `claude -p --session-id ${heldId} --model haiku` }]),
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toMatch(new RegExp(`worker session ${heldId}.*process 4242`));
  expect(worker.recorded.length).toBe(recordedBefore);
  const after = await readState(paths.stateFile);
  expect(after.stepsUsed).toBe(stepsBefore);
  expect(after.lifecycle).toBe("interrupted");

  const resumed = await executeRoleCommand(
    withRepo(dispatchArgv(["--resume-interrupted"]), repo),
    deps([]),
  );
  expect(resumed.exitCode).toBe(0);
  expect(worker.recorded.at(-1).incomingSessionId).toBe(heldId);
});

// Usefulness: verifies a cancel of the process-table read during `--resume-interrupted` exits 130 with the SIGINT envelope and charges no step (#725, ADR 0031 decision 2), which the refusal test does not cover.
test("resume-interrupted exits 130 when the process-table read is canceled", async () => {
  const repo = await newRunRepo();
  const paths = statePaths({ cwd: repo });
  const worker = recordingAdapter([]);
  const deps = {
    agents: { claude: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    readProcessCommands: async () => {
      throw new ProcessReadError("was canceled", { isCanceled: true });
    },
  };

  await executeRoleCommand(
    withRepo(dispatchArgv(INIT_OVERRIDES.map((v) => (v === "fake1" ? "claude" : v))), repo),
    { ...deps, readProcessCommands: async () => [] },
  );
  const state = await readState(paths.stateFile);
  state.lifecycle = "interrupted";
  state.roles.worker.sessionId = "11111111-2222-4333-8444-555555555555";
  await writeState(paths.stateFile, state);
  const recordedBefore = worker.recorded.length;

  const result = await executeRoleCommand(
    withRepo(dispatchArgv(["--resume-interrupted"]), repo),
    deps,
  );

  expect(result.exitCode).toBe(130);
  expect(result.payload).toEqual({ status: "error", error: "Interrupted by SIGINT" });
  expect(worker.recorded.length).toBe(recordedBefore);
  expect((await readState(paths.stateFile)).stepsUsed).toBe(state.stepsUsed);
});

// A `gh` double for the gate's reads of PR 42 whose required check `ci (macos-latest)`
// fails on the PR head `localHead`.
const failingCheckGh = (localHead) =>
  prGateGh(
    localHead,
    [],
    [{ ...PASSING_RUN, name: "ci (macos-latest)", conclusion: "failure" }],
    "ci (macos-latest)",
  );

// Usefulness: verifies acceptance — a run that declared a PR supplies the
// required-check status the runtime read to the reviewer turn and reports that
// read in the envelope and in the state file, so the parent can compare it with
// the reviewer Checks line (issue #320).
test("a declared PR supplies the runtime-read required-check status to the reviewer", async () => {
  const repo = await newRunRepo();
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const init = dispatchArgv([...INIT_OVERRIDES, "--pr", "42"], "worker");
  await executeRoleCommand(withRepo(init, repo), {
    agents,
    stdin: stdinPrompt,
    gh: failingCheckGh("1".repeat(40)),
  });

  // The status read resolves the PR head and compares it with the local reviewed
  // head, then judges the required contexts on the check runs of that commit.
  const localHead = (await snapshot(repo)).head;
  const gh = failingCheckGh(localHead);
  const turn = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
    gh,
  });

  expect(reviewer.recorded[0].prompt).toContain("ci (macos-latest)");
  expect(turn.payload).toMatchObject({ role: "reviewer", prChecks: { pr: 42, status: "failing" } });
  const state = await readRepoState(repo);
  expect(state.lastResult.prChecks).toMatchObject({ pr: 42, status: "failing" });
});
