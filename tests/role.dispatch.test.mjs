import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on (see
// `gitWhileDotGitExists` in runtime-helpers.mjs); every other test reaches the real `execa`.
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
import { executeRoleCommand, main as runRoleMain } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  REPORT,
  repos,
  settleStreamEvents,
  setup,
  spyStdoutWrite,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import {
  apiArgs,
  createTempRepo,
  equalsArgs,
  expectNoReplyToMalformedCalls,
  gateReadCalls,
  gitAbortingPostTurn,
  gitWhileDotGitExists,
  isApiRead,
  PAGED,
  prChecksArgs,
  prViewArgs,
  removePath,
  REPO_VIEW_ARGS,
} from "./runtime-helpers.mjs";

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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

// Usefulness: verifies the dispatch seam carries the optional Checks, Notes,
// and Deferred labels from a reviewer turn into the envelope (issue #214,
// issue #217).
test("reviewer dispatch carries the optional Checks, Notes, and Deferred labels", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-notes";
    return `${REPORT}\nChecks: npm test\nNotes: tidy the helper later\nDeferred: migrate the legacy path\nVerdict: accept`;
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toMatchObject({
    checks: "npm test",
    notes: "tidy the helper later",
    deferred: "migrate the legacy path",
  });
});

// Usefulness: verifies an empty optional label with bullets below it reaches the
// envelope through `raw` at the dispatch seam instead of being dropped (issue
// #229).
test("worker dispatch carries text under an empty optional label into raw", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-notes";
    return `${REPORT}\nNotes:\n- item one\n- item two`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain("item one");
});

// Usefulness: verifies a decorated optional label reaches the envelope through
// `raw` at the dispatch seam instead of dropping its value (issue #243).
test("worker dispatch carries a decorated label into raw", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-decorated";
    return `${REPORT}\nNotes: tidy\n**Deferred:** migrate the legacy path`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain("migrate the legacy path");
});

// Usefulness: verifies a bullet with no space after the marker under an empty
// optional label reaches the envelope through `raw` at the dispatch seam
// instead of being dropped (issue #243).
test("worker dispatch carries a spaceless bullet into raw", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-spaceless";
    return `${REPORT}\nDeferred:\n-migrate the legacy path`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain("migrate the legacy path");
});

// Usefulness: verifies a bullet list under the required `Blockers` label reaches
// the envelope through `raw` at the dispatch seam instead of being dropped, so
// the next turn still sees the blocker (issue #240).
test("worker dispatch carries a list under the Blockers label into raw", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-blocker";
    return `${REPORT}\nBlockers: see below\n- real blocker`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain("real blocker");
});

// Usefulness: verifies a list under an earlier, shadowed occurrence of a label
// reaches the envelope through `raw` at the dispatch seam instead of being
// dropped when a later occurrence wins the label value (issue #249).
test("worker dispatch carries a list under a shadowed earlier label into raw", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-shadow";
    return `${REPORT}\nNotes: first pass\n- dropped item\nNotes: second pass`;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toContain("dropped item");
});

// Usefulness: verifies the dispatch seam when the closing block does not parse
// — the payload carries a null report and the raw response, so a caller can
// still inspect what the child returned instead of guessing.
test("reviewer dispatch exposes a null report and the raw response when the block does not parse", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([]);
  reviewer.run = async (state) => {
    state.sessionId = "rev-raw";
    return "looks fine, but no verdict line here";
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.verdict).toBe("unknown");
  expect(result.payload.raw).toContain("looks fine");
});

// Usefulness: verifies a closing block longer than the old 2000-character bound
// keeps its whole text in `raw`, including a dropped list near the head, so the
// flagged line still fails safe when the block is long (issue #268). A tail-only
// fallback loses the head of the block, so this test fails against that behavior.
test("worker dispatch carries the whole response in raw when the closing block is long", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const response = [
    "Conclusion: done",
    "Notes:",
    "- dropped marker ALPHA",
    `Why: ${"x".repeat(2500)}`,
    "Blockers: none",
  ].join("\n");

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-long-raw";
    return response;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload.report).toBeNull();
  expect(result.payload.raw).toBe(response);
});

// Usefulness: verifies --transcript appends one invocation and one result
// event per dispatched turn, in the headless event shape, accumulated across
// calls.
test("dispatch appends invocation and result events to the transcript", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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

// Usefulness: verifies later calls read configuration from the state file —
// an identical repeated flag passes through, a changed one is rejected with
// the change message.
test("later dispatch rejects changed init flags and accepts identical ones", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "5"]), repo),
    basicDeps(),
  );

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--max-steps", "5"]), repo),
    basicDeps(),
  );
  expect(identical.exitCode).toBe(0);

  const changed = await executeRoleCommand(
    withRepo(dispatchArgv(["--max-steps", "9"]), repo),
    basicDeps(),
  );
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--max-steps cannot be changed after init");

  const changedTimeout = await executeRoleCommand(
    withRepo(dispatchArgv(["--timeout", "5"]), repo),
    basicDeps(),
  );
  expect(changedTimeout.exitCode).toBe(1);
  expect(changedTimeout.payload.error).toContain("--timeout cannot be changed after init");
});

// Usefulness: verifies an empty stdin prompt exits non-zero, charges no step,
// and spawns no CLI (regression: the empty check only covered --prompt-file).
test("empty stdin prompt is rejected without charging a step", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

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
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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

// Usefulness: verifies `--resume-interrupted` refuses a claude session that a live process holds, before the step is charged (#671, ADR 0031), which no other test covers.
test("resume-interrupted refuses a claude session that a live process holds", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
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

// Usefulness: verifies only the role kind is normalized in the change
// comparison — model and effort are opaque pass-through strings, so repeating
// an identical `--worker-model antigravity` passes and a changed one is
// rejected (regression: normalizeAgent mangled the model string).
test("identical model and effort flags pass comparison verbatim", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(
      dispatchArgv([
        ...INIT_OVERRIDES,
        "--worker-model",
        "antigravity",
        "--worker-effort",
        "high",
        "--reviewer-model",
        "gemini-2.5-pro",
      ]),
      repo,
    ),
    basicDeps(),
  );
  const state = await readRepoState(repo);
  expect(state.roles.worker.model).toBe("antigravity");

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker-model", "antigravity", "--worker-effort", "high"]), repo),
    basicDeps(),
  );
  expect(identical.exitCode).toBe(0);

  const changed = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker-model", "antigravity", "--worker-effort", "low"]), repo),
    basicDeps(),
  );
  expect(changed.exitCode).toBe(1);
  expect(changed.payload.error).toContain("--worker-effort cannot be changed after init");
});

// Usefulness: verifies the `antigravity` kind alias passes the change
// comparison through normalization while model strings stay verbatim.
test("antigravity kind alias passes comparison, model strings do not normalize", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  await executeRoleCommand(
    withRepo(
      dispatchArgv([...INIT_OVERRIDES, "--worker", "antigravity", "--worker-model", "antigravity"]),
      repo,
    ),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  const state = await readRepoState(repo);
  expect(state.roles.worker.kind).toBe("agy");
  expect(state.roles.worker.model).toBe("antigravity");

  const identical = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "antigravity", "--worker-model", "antigravity"]), repo),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(identical.exitCode).toBe(0);

  const changedModel = await executeRoleCommand(
    withRepo(dispatchArgv(["--worker", "antigravity", "--worker-model", "gemini"]), repo),
    { agents: { agy: recordingAdapter([]), fake2: recordingAdapter([]) }, stdin: stdinPrompt },
  );
  expect(changedModel.exitCode).toBe(1);
  expect(changedModel.payload.error).toContain("--worker-model cannot be changed after init");
});

// Usefulness: verifies acceptance — stdout holds exactly one JSON object on
// every path, including errors (verified through the main entry point).
test("main prints exactly one JSON object on stdout on success and error paths", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const logSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      {
        agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
      },
    );
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ status: "ok", role: "worker" });

    logSpy.mockClear();
    await runRoleMain(["dispatch", "--cwd", repo], { agents: {} });
    expect(logSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
      status: "error",
      error: expect.stringContaining("dispatch requires --role"),
    });
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies an error whose message cannot be read still yields one JSON envelope
// through main, and that a cancel raised while reading it keeps exit 130 (SIGINT during the read).
test.each([
  [true, 130],
  [false, 1],
])(
  "main prints one error envelope when the message getter throws (isCanceled=%s, exit %i)",
  async (isCanceled, exitCode) => {
    await setup();
    const repo = await createTempRepo();
    repos.push(repo);
    const logSpy = spyStdoutWrite();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const origExitCode = process.exitCode;

    try {
      const promptFile = join(repo, "main-prompt.txt");
      await writeFile(promptFile, "work it", "utf8");
      const unreadable = {
        get message() {
          process.emit("SIGINT");
          throw Object.assign(new Error("message getter failed"), { isCanceled });
        },
      };
      const agents = {
        get fake1() {
          throw unreadable;
        },
        fake2: recordingAdapter([]),
      };
      await runRoleMain(
        [
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        { agents },
      );
      expect(logSpy.mock.calls.length).toBe(1);
      expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ status: "error" });
      expect(process.exitCode).toBe(exitCode);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = origExitCode;
    }
  },
);

// Usefulness: acceptance (#669) — the SIGINT listener of role main stays registered after the signal
// fires, so the execa exit handler finds another listener and does not re-raise it before the
// envelope prints.
test("the SIGINT listener of role main stays registered after the signal fires", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const logSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;
  const before = process.listenerCount("SIGINT");
  let during;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        process.emit("SIGINT");
        during = process.listenerCount("SIGINT");
        throw Object.assign(new Error("canceled"), { isCanceled: true });
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a thrown value whose message is not a string (BigInt, circular object,
// throwing toJSON) still yields one JSON error envelope through main instead of a stringify crash.
test.each([
  ["a BigInt", () => 10n, "10"],
  [
    "a circular object",
    () => {
      const loop = {};
      loop.self = loop;
      return loop;
    },
    "[unserializable message]",
  ],
  [
    "an object whose toJSON throws",
    () => ({
      toJSON() {
        throw new Error("toJSON failed");
      },
    }),
    "[unserializable message]",
  ],
  ["a function", () => () => {}, "[unserializable message]"],
  ["a Symbol", () => Symbol("message"), "[unserializable message]"],
  ["an object whose toJSON returns undefined", () => ({ toJSON() {} }), "[unserializable message]"],
  ["an object whose toJSON returns null", () => ({ toJSON: () => null }), null],
  ["NaN", () => Number.NaN, null],
  ["Infinity", () => Number.POSITIVE_INFINITY, null],
])("main prints one error envelope when the message is %s", async (_label, makeMessage, text) => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw { message: makeMessage() };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    expect(writeSpy.mock.calls.length).toBe(1);
    expect(JSON.parse(writeSpy.mock.calls[0][0])).toEqual({ status: "error", error: text });
    expect(process.exitCode).toBe(1);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a fatal child error whose message getter throws still ends the turn with a
// terminal lifecycle and a recorded turn, so the state file never keeps the dispatched lifecycle.
test("dispatch records the turn when reading the fatal error message throws", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
  Object.defineProperty(fatal, "message", {
    get() {
      throw new Error("message getter failed");
    },
  });
  const agents = {
    fake1: {
      async run() {
        throw fatal;
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("halted");
  expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
  expect(state.lastResult).toMatchObject({ status: "error" });
});

// Usefulness: verifies a fatal child error whose testRun getter throws still ends the turn with a
// terminal lifecycle and a recorded turn, so the state file never keeps the dispatched lifecycle.
test("dispatch records the turn when reading the fatal error testRun throws", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
  Object.defineProperty(fatal, "testRun", {
    get() {
      throw new Error("testRun getter failed");
    },
  });
  const agents = {
    fake1: {
      async run() {
        throw fatal;
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("halted");
  expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
});

// Usefulness: verifies a child error whose name or timedOut getter throws returns an error result
// through the runtime, instead of the throw escaping the runtime catch block.
test.each(["name", "timedOut"])(
  "dispatch returns an error result when the child error %s getter throws",
  async (property) => {
    await setup();
    const repo = await createTempRepo();
    repos.push(repo);
    const failure = new Error("child failed");
    Object.defineProperty(failure, property, {
      get() {
        throw new Error(`${property} getter failed`);
      },
    });
    const agents = {
      fake1: {
        async run() {
          throw failure;
        },
      },
      fake2: recordingAdapter([]),
    };

    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      agents,
      stdin: stdinPrompt,
    });

    expect(result.payload).toMatchObject({
      role: "worker",
      status: "error",
      error: "child failed",
    });
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("active");
    expect(state.turns).toMatchObject([{ role: "worker", status: "error" }]);
  },
);

// Usefulness: verifies a child error with a non-string message returns an error result through the
// runtime, instead of the TypeError that splitting the message raised.
test("dispatch returns an error result when a child error has a non-string message", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const agents = {
    fake1: {
      async run() {
        throw { message: { code: 42 } };
      },
    },
    fake2: recordingAdapter([]),
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ role: "worker", status: "error" });
  expect(String(result.payload.error)).toContain("42");
});

// Usefulness: verifies a failed stdout write (callback error or a throw) is reported on stderr and
// in a non-zero exit code, so a lost envelope never looks like a clean exit 0.
test.each([
  ["through the write callback", false],
  ["by throwing", true],
])("main reports a failed stdout write %s", async (_label, throws) => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const writeSpy = spyStdoutWrite({ failure, throws });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    process.exitCode = 0;
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) } },
    );
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("EPIPE");
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a non-string message prints exactly as the base envelope printed it, under
// the key "error", so a toJSON that redacts by key still redacts and discloses nothing more.
test("main serializes a non-string message under the error key like the base envelope", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw { message: { toJSON: (key) => (key === "error" ? "[redacted]" : "LEAKED-CONTENT") } };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).not.toContain("LEAKED-CONTENT");
    expect(JSON.parse(printed)).toEqual({ status: "error", error: "[redacted]" });
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a stateful toJSON is called once, so the envelope and the state file both
// hold the first (redacted) value and a later call cannot change what was printed or persisted.
test("main calls a message toJSON once and prints and persists the same value", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    let calls = 0;
    const fatal = Object.assign(new Error("fatal"), { name: "MutationError" });
    Object.defineProperty(fatal, "message", {
      value: { toJSON: () => (++calls === 1 ? "[redacted]" : "LEAKED-CONTENT") },
    });
    const agents = {
      fake1: {
        async run() {
          throw fatal;
        },
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(JSON.parse(printed)).toMatchObject({ status: "error", error: "[redacted]" });
    expect((await readRepoState(repo)).lastResult.error).toBe("[redacted]");
    expect(calls).toBe(1);
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// Usefulness: verifies a stdout that errors asynchronously (closed pipe) leaves no unhandled
// stream error, and that a failed write keeps a cancel exit 130 rather than turning it into 1.
test.each([
  [true, 130],
  [false, 1],
])(
  "main consumes the stdout error event and keeps a non-zero exit code (isCanceled=%s, exit %i)",
  async (isCanceled, exitCode) => {
    await setup();
    const repo = await createTempRepo();
    repos.push(repo);
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const writeSpy = spyStdoutWrite({ failure, emitsErrorEvent: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const origExitCode = process.exitCode;

    try {
      const promptFile = join(repo, "main-prompt.txt");
      await writeFile(promptFile, "work it", "utf8");
      const agents = {
        get fake1() {
          throw {
            get message() {
              process.emit("SIGINT");
              throw Object.assign(new Error("message getter failed"), { isCanceled });
            },
          };
        },
        fake2: recordingAdapter([]),
      };
      await runRoleMain(
        [
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        { agents },
      );
      await settleStreamEvents();
      expect(writeSpy.unhandledErrorEvents).toBe(0);
      expect(process.exitCode).toBe(exitCode);
      expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("EPIPE");
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = origExitCode;
    }
  },
);

// Usefulness: verifies coercing a non-string message never prints more than the base envelope
// did: a value that its toJSON redacts stays redacted, and its toString is never read.
test("main keeps a non-string message redacted by its toJSON", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const writeSpy = spyStdoutWrite();
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const origExitCode = process.exitCode;

  try {
    const promptFile = join(repo, "main-prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const agents = {
      get fake1() {
        throw {
          message: {
            toJSON: () => "[redacted]",
            toString: () => "SECRET-MARKER",
          },
        };
      },
      fake2: recordingAdapter([]),
    };
    await runRoleMain(
      [
        "dispatch",
        "--role",
        "worker",
        "--cwd",
        repo,
        ...INIT_OVERRIDES,
        "--prompt-file",
        promptFile,
      ],
      { agents },
    );
    const printed = writeSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).not.toContain("SECRET-MARKER");
    expect(JSON.parse(printed)).toMatchObject({
      status: "error",
      error: expect.stringContaining("[redacted]"),
    });
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = origExitCode;
  }
});

// A `gh` double for the gate's reads of PR 42 whose required check `ci (macos-latest)`
// fails on the PR head `localHead`. It replies only to the exact argument elements
// of each read and fails any other call with the arguments printed as an array.
function failingCheckGh(localHead) {
  return async (args) => {
    const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (equalsArgs(args, prViewArgs(42))) {
      return json({ headRefOid: localHead, baseRefName: "main", mergeStateStatus: "CLEAN" });
    }
    if (equalsArgs(args, REPO_VIEW_ARGS)) {
      return { status: 0, stdout: "owner/repo", stderr: "" };
    }
    if (equalsArgs(args, apiArgs("repos/owner/repo/rules/branches/main"))) {
      return json([
        [
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci (macos-latest)" }] },
          },
        ],
      ]);
    }
    if (equalsArgs(args, apiArgs("repos/owner/repo/branches/main/protection", []))) {
      return { status: 1, stdout: "", stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (isApiRead(args, "/check-runs", PAGED)) {
      return json([
        {
          check_runs: [
            {
              id: 1,
              name: "ci (macos-latest)",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
      ]);
    }
    if (isApiRead(args, "/status", PAGED)) {
      return json([{ statuses: [] }]);
    }
    // `gh pr checks` names no check beyond the ruleset.
    if (equalsArgs(args, prChecksArgs(42))) {
      return json([]);
    }
    return { status: 1, stdout: "", stderr: `unmatched gh call: ${JSON.stringify(args)}` };
  };
}

// Usefulness: verifies the double for the failing required check replies only to the
// exact argument elements of the gate's reads, so a malformed call gets no reply and
// the reviewer-turn test cannot pass on a call that no longer matches (issue #538).
test("the failing-check double gives no reply to a malformed call", async () => {
  await expectNoReplyToMalformedCalls(
    failingCheckGh("a".repeat(40)),
    gateReadCalls("a".repeat(40)),
  );
});

// Usefulness: verifies acceptance — a run that declared a PR supplies the
// required-check status the runtime read to the reviewer turn and reports that
// read in the envelope and in the state file, so the parent can compare it with
// the reviewer Checks line (issue #320).
test("a declared PR supplies the runtime-read required-check status to the reviewer", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };
  const init = dispatchArgv([...INIT_OVERRIDES, "--pr", "42"], "worker");
  await executeRoleCommand(withRepo(init, repo), { agents, stdin: stdinPrompt });

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

// Usefulness: verifies a failed first turn that reported a session id persists it, so the next
// dispatch resumes that session, and a missing resumed session clears the stored id and reruns as
// a first turn without a second step (issue #360, ADR 0016).
test("a failed first turn keeps its session id and a missing session falls back in one step", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const prompts = [];
  const worker = {
    async run(state, prompt) {
      prompts.push({ sessionId: state.sessionId, prompt });
      if (prompts.length === 1) {
        state.sessionId = "sess-failed";
        throw new Error("boom");
      }
      if (state.sessionId === "sess-failed") {
        throw Object.assign(new Error("No conversation found"), { sessionMissing: true });
      }
      state.sessionId = "sess-new";
      return REPORT;
    },
  };
  const agents = { fake1: worker, fake2: recordingAdapter([]) };

  const first = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(first.payload).toMatchObject({ status: "error" });
  expect((await readRepoState(repo)).roles.worker.sessionId).toBe("sess-failed");

  const second = await executeRoleCommand(withRepo(dispatchArgv(), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(second.payload).toMatchObject({ status: "ok" });
  expect(prompts.map((p) => p.sessionId)).toEqual([null, "sess-failed", null]);
  expect(prompts[1].prompt).not.toContain("You are the implementation agent");
  expect(prompts[2].prompt).toContain("You are the implementation agent");

  const state = await readRepoState(repo);
  expect(state).toMatchObject({ stepsUsed: 2 });
  expect(state.turns).toHaveLength(2);
  expect(state.roles.worker.sessionId).toBe("sess-new");
});

// Usefulness: verifies a cancel that ends the turn after the CLI reported its session still
// persists the id for the resume that follows.
test("a canceled turn keeps the session id the CLI reported", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const worker = {
    async run(state) {
      state.sessionId = "sess-canceled";
      throw Object.assign(new Error("canceled"), { isCanceled: true });
    },
  };

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(130);
  expect((await readRepoState(repo)).roles.worker.sessionId).toBe("sess-canceled");
});

// Usefulness: verifies a cancel that lands after the CLI exits and before the adapter returns ends
// the turn interrupted with exit 130, not recorded ok with the run left active (#587).
test("a cancel after the child exits records the turn as canceled", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const controller = new AbortController();
  const worker = recordingAdapter([
    () => {
      controller.abort();
      return REPORT;
    },
  ]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    signal: controller.signal,
  });

  expect(result.exitCode).toBe(130);
  expect(result.payload.status).toBe("error");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
});

// Usefulness: verifies a cancel that lands during the post-turn snapshot of a reviewer turn, after the
// adapter returned, ends the turn interrupted with exit 130 and records no ok result (#587).
test("a cancel during the post-turn snapshot records the reviewer turn as canceled", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const controller = new AbortController();
  const post = gitAbortingPostTurn(controller);
  gitDouble.answer = post.git;
  const reviewer = recordingAdapter([
    () => {
      post.arm();
      return REPORT;
    },
  ]);

  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: reviewer },
    stdin: stdinPrompt,
    signal: controller.signal,
  });

  expect(post.fired).toBe(true);
  expect(result.exitCode).toBe(130);
  expect(result.payload.status).toBe("error");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
});

// Usefulness: verifies ADR 0027 decision 5 for a replaced conversation: a canceled dispatch persists the
// id the CLI reported with the replaced mark, and the next worker dispatch sends the preamble (#587).
test("a canceled dispatch persists the reported id and the next worker turn sends the preamble", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  const controller = new AbortController();
  const replaced = recordingAdapter([
    (state) => {
      state.sessionId = "replacement";
      state.conversationReplaced = true;
      controller.abort();
      return REPORT;
    },
  ]);

  const canceled = await executeRoleCommand(withRepo(dispatchArgv([]), repo), {
    agents: { fake1: replaced, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    signal: controller.signal,
  });
  expect(canceled.exitCode).toBe(130);
  expect((await readRepoState(repo)).roles.worker).toMatchObject({
    sessionId: "replacement",
    conversationReplaced: true,
  });

  const next = recordingAdapter([]);
  const result = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents: { fake1: next, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(next.recorded[0].incomingSessionId).toBe("replacement");
  expect(next.recorded[0].prompt).toContain("You are the implementation agent");
  expect((await readRepoState(repo)).roles.worker.conversationReplaced).toBeUndefined();
});

// Usefulness: verifies that an empty parentSession on a parsed init command
// stays an unguarded run, as before the statePaths call-site cleanup (#189),
// while statePaths itself still rejects a null session id.
test("dispatch init with an empty parentSession succeeds without a session entry", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const args = { ...withRepo(dispatchArgv(INIT_OVERRIDES), repo), parentSession: "" };
  const result = await executeRoleCommand(args, {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.exitCode).toBe(0);
  expect(result.payload).toMatchObject({ role: "worker", status: "ok" });
});

// Usefulness: verifies a pre-assigned session id reaches the state file before the child runs, so
// a parent crash during a first turn still leaves the id that the resume after
// `--resume-interrupted` needs (issue #395). No other test reads the state file mid-turn.
test("a pre-assigned session id is persisted before the child turn runs", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  let midTurn = null;
  const worker = {
    async run(state, _prompt, options) {
      await options.onSessionAssigned("pre-1");
      midTurn = await readState(paths.stateFile);
      throw new Error("parent crashed");
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(midTurn).toMatchObject({
    lifecycle: "dispatched",
    roles: { worker: { sessionId: "pre-1" } },
  });

  // Restore the mid-turn file, as left by a crash, then recover.
  await writeState(paths.stateFile, midTurn);
  const resumer = recordingAdapter([]);
  const agents = { fake1: resumer, fake2: recordingAdapter([]) };
  const marked = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(marked.exitCode).toBe(1);
  const resumed = await executeRoleCommand(withRepo(dispatchArgv(["--resume-interrupted"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(resumed.exitCode).toBe(0);
  expect(resumer.recorded[0].incomingSessionId).toBe("pre-1");
});

// Usefulness: verifies the early-persisted id is cleared in the state file as soon as the adapter
// reports it rejected, so a parent crash right after the rejection cannot leave an id that
// `--resume-interrupted` would resume (issue #395). The result write alone cannot cover that window.
test("a rejected pre-assigned id is cleared from the state file before the turn ends", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  let afterRejection = null;
  const worker = {
    async run(_state, _prompt, options) {
      await options.onSessionAssigned("pre-rejected");
      await options.onSessionAssigned(null);
      afterRejection = await readState(paths.stateFile);
      throw new Error("parent crashed");
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(afterRejection).toMatchObject({
    lifecycle: "dispatched",
    roles: { worker: { sessionId: null } },
  });
});

// Usefulness: verifies a turn that fails with no id on its role state clears the id persisted
// before the turn, so a rejected pre-assigned id never becomes a resume target (issue #395).
test("a failed first turn that keeps no id clears the pre-assigned id from the state file", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const worker = {
    async run(state, _prompt, options) {
      await options.onSessionAssigned("pre-rejected");
      state.sessionId = null;
      throw new Error("Session ID pre-rejected is already in use.");
    },
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(result.payload).toMatchObject({ status: "error" });
  expect((await readRepoState(repo)).roles.worker.sessionId).toBeNull();
});

// Usefulness: verifies the unconfirmed mark is saved with the early id, so recovery can tell an
// id the CLI never confirmed from one it did, and that a turn which confirms it clears the saved
// mark (issue #395).
test("the state file marks a pre-assigned id unconfirmed until the turn confirms it", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const paths = statePaths({ cwd: repo });
  let midTurn = null;
  const worker = {
    async run(state, _prompt, options) {
      state.sessionUnconfirmed = true;
      await options.onSessionAssigned("pre-2");
      midTurn = await readState(paths.stateFile);
      state.sessionId = "pre-2";
      delete state.sessionUnconfirmed;
      return REPORT;
    },
  };
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
  expect(midTurn.roles.worker).toMatchObject({ sessionId: "pre-2", sessionUnconfirmed: true });
  const after = (await readState(paths.stateFile)).roles.worker;
  expect(after.sessionId).toBe("pre-2");
  expect(after.sessionUnconfirmed).toBeUndefined();
});

// Usefulness: verifies requirement "a denied shell call shows in the result of the turn" (issue #713) at the envelope: the parent sees `shellDenied`, and the role state keeps no stale flag.
test("worker dispatch carries shellDenied in the envelope when the adapter flags a denied shell call", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const worker = recordingAdapter([]);
  worker.run = async (state) => {
    state.sessionId = "sess-denied";
    state.shellDenied = true;
    return REPORT;
  };
  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.status).toBe("ok");
  expect(result.payload.shellDenied).toBe(true);
  expect((await readRepoState(repo)).roles.worker).not.toHaveProperty("shellDenied");
});

// Usefulness: verifies requirement "the flag follows read-only turns too" (issue #713, ADR 0035): a reviewer envelope carries `shellDenied`, and a later reviewer turn with no denial carries none.
test("reviewer dispatch carries shellDenied only for the turn that had it", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const reviewer = recordingAdapter([
    (state) => {
      state.sessionId = "rev-denied";
      state.shellDenied = true;
      return `${REPORT}\nVerdict: accept`;
    },
    `${REPORT}\nVerdict: accept`,
  ]);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), basicDeps());
  const deps = { agents: { fake1: recordingAdapter([]), fake2: reviewer }, stdin: stdinPrompt };
  const first = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);
  const second = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), deps);

  expect(first.payload.shellDenied).toBe(true);
  expect(second.payload.status).toBe("ok");
  expect(second.payload).not.toHaveProperty("shellDenied");
});
