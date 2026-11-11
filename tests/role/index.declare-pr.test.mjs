import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

// Answers `git` from memory for the tests that switch it on, so no test here
// starts a `git` process.
//
// `cleanRepoGit` answers the Git guards and reads from memory: `assertGitWorkTree` and `snapshot`
// (`src/lib/snapshot.mjs`), `locateLocalFiles` (`src/lib/local-files.mjs`), `readSharedGit`
// (`src/lib/evidence/shared-git.mjs`), `readMainWorkTree` (`src/lib/evidence/main-work-tree-change.mjs`),
// `readLockfiles` (`src/lib/evidence/lockfile-change.mjs`), and `resolveWorkerPr` (`src/lib/worker-pr.mjs`).
// These cases assert no Git result.
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

import { SPAWNED_RUN_ENV, spawnedRunMarker } from "../../src/lib/exec.mjs";
import { snapshot } from "../../src/lib/snapshot.mjs";
import { executeRoleCommand, parseRoleArgs } from "../../src/role/index.mjs";
import {
  ACCEPT,
  cleanup,
  dispatchArgv,
  dispatchReviewer,
  finishCall,
  initPrRun,
  initRun,
  newCleanRunRepo,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./helpers.mjs";
import {
  freePlanGh,
  PASSING_RUN,
  noRequiredCheckGh,
  pagedApiArgs,
  prChecksArgs,
  prGateGh,
  unreachableGh,
} from "../gh-doubles.mjs";
import { CLEAN_REPO_HEAD, cleanRepoGit } from "../git-helpers.mjs";
import { SUMMARY } from "../run-fixtures.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  gitDouble.answer = null;
});

// A directory with a `.git` entry stands in for a repo, and `git` is answered
// from memory. The test starts no `git` process.
async function useCleanRepo() {
  const repo = await mkdtemp(join(tmpdir(), "role-test-clean-repo-"));
  await mkdir(join(repo, ".git"));
  repos.push(repo);
  gitDouble.answer = cleanRepoGit;
  return repo;
}

const declareArgv = (pr, ...flags) => [
  "declare-pr",
  "--cwd",
  "<repo>",
  "--parent-session",
  "parent-sess-1",
  "--pr",
  String(pr),
  ...flags,
];

/** Starts a run with the given init options; `gh` answers the start read of a declared PR. */
async function startRun(options = {}) {
  const repo = await newCleanRunRepo(gitDouble);
  return { repo, agents: await initRun(repo, { gh: prGateGh("1".repeat(40)), ...options }) };
}

const declare = (repo, pr, ...flags) =>
  executeRoleCommand(withRepo(declareArgv(pr, ...flags), repo), {
    gh: prGateGh("1".repeat(40)),
  });

const declareWith = (repo, gh, pr = 42) =>
  executeRoleCommand(withRepo(declareArgv(pr), repo), { gh });

// Usefulness: verifies acceptance of #916 — a run that declared its PR after init supplies the
// required-check status to the next reviewer prompt and reports it in the envelope, as a run
// that declared the PR at init does.
test("a PR declared after init supplies the check status to the next reviewer turn", async () => {
  const { repo } = await startRun();
  const reviewer = recordingAdapter([]);
  const agents = { fake1: recordingAdapter([]), fake2: reviewer };

  const declared = await declare(repo, 42);
  expect(declared.exitCode).toBe(0);
  expect(declared.payload).toMatchObject({ status: "ok", lifecycle: "active", pr: 42 });

  const gh = prGateGh(
    (await snapshot(repo)).head,
    [],
    [{ ...PASSING_RUN, name: "ci (macos-latest)", conclusion: "failure" }],
    "ci (macos-latest)",
  );
  const turn = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
    gh,
  });
  expect(reviewer.recorded[0].prompt).toContain("ci (macos-latest)");
  expect(turn.payload).toMatchObject({ prChecks: { pr: 42, status: "failing" } });
});

// Usefulness: verifies acceptance of #916 — a run that declared its PR after init refuses a
// finish with no `--require-ci` gate for that PR, and a finish with a gate for another PR.
test("a PR declared after init refuses a finish without the gate for that PR", async () => {
  const { repo } = await startRun();
  await declare(repo, 42);
  const gh = async () => {
    throw new Error("gh must not run: the finish is refused before the gate.");
  };
  for (const extra of [[], ["--require-ci", "7"]]) {
    const refused = await executeRoleCommand(
      withRepo(["finish", "--cwd", "<repo>", ...extra], repo),
      { stdin: async () => JSON.stringify(SUMMARY), gh },
    );
    expect(refused.exitCode, extra.join(" ")).toBe(1);
    expect(refused.payload.error).toContain("declares PR 42");
    expect(refused.payload.error).toContain("--require-ci 42");
  }
  expect((await readRepoState(repo)).lifecycle).toBe("active");
});

// Usefulness: verifies the transition is one-way — a run that holds a PR, from init or from an
// earlier declare, refuses another declaration, so a declared PR cannot be moved to another PR.
test("declare-pr refuses a run that already has a PR", async () => {
  const atInit = await startRun({ initFlags: ["--pr", "42"] });
  const sameNumber = await declare(atInit.repo, 42);
  const otherNumber = await declare(atInit.repo, 43);
  for (const result of [sameNumber, otherNumber]) {
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("already declares PR 42");
  }
  expect((await readRepoState(atInit.repo)).pr).toBe(42);

  const { repo } = await startRun();
  expect((await declare(repo, 42)).exitCode).toBe(0);
  const again = await declare(repo, 43);
  expect(again.exitCode).toBe(1);
  expect((await readRepoState(repo)).pr).toBe(42);
});

// Usefulness: verifies a terminal run refuses a declaration and keeps its recorded state.
test("declare-pr refuses a terminal run", async () => {
  const { repo } = await startRun();
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const result = await declare(repo, 42);
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toContain("Run is already aborted");
  expect((await readRepoState(repo)).pr).toBeNull();
});

// Usefulness: verifies a spawned child of the run is refused like extend, finish, and abort, so
// a worker cannot choose the PR that gates its own run. The same call without a marker works.
test("declare-pr refuses a child caller of the run", async () => {
  const { repo } = await startRun();
  vi.stubEnv(SPAWNED_RUN_ENV, spawnedRunMarker(repo));
  const refused = await declare(repo, 42);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("child role");
  expect((await readRepoState(repo)).pr).toBeNull();

  vi.stubEnv(SPAWNED_RUN_ENV, "");
  expect((await declare(repo, 42)).exitCode).toBe(0);
});

// Usefulness: verifies the call needs a PR number and the run's parent session id, and that each
// refusal leaves the state as it was.
test("declare-pr refuses a missing PR, a missing parent session, and a wrong one", async () => {
  const { repo } = await startRun();
  expect(() => parseRoleArgs(["declare-pr", "--cwd", repo, "--pr", "0"])).toThrow();

  const noPr = await executeRoleCommand(
    withRepo(["declare-pr", "--cwd", "<repo>", "--parent-session", "parent-sess-1"], repo),
  );
  expect(noPr.payload.error).toContain("--pr");

  const noSession = await executeRoleCommand(
    withRepo(["declare-pr", "--cwd", "<repo>", "--pr", "42"], repo),
  );
  expect(noSession.payload.error).toContain("--parent-session");

  const wrong = await executeRoleCommand(
    withRepo(["declare-pr", "--cwd", "<repo>", "--parent-session", "other", "--pr", "42"], repo),
  );
  expect(wrong.payload.error).toContain("does not match");
  expect((await readRepoState(repo)).pr).toBeNull();
});

// Usefulness: verifies a review-only run, which refuses `--pr` at init because it cannot pass the
// `--require-ci` gate, refuses a declaration after init too.
test("declare-pr refuses a review-only run", async () => {
  const { repo } = await startRun({ initFlags: ["--mode", "review-only"], role: "reviewer" });
  const refused = await declare(repo, 42);
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("review-only");
  expect((await readRepoState(repo)).pr).toBeNull();
});

// Usefulness: verifies acceptance of #1092 — declare-pr on a repository whose required-check sources
// all answer the Free-plan 403 is refused with the fix named and leaves the run unchanged, so the
// run can still finish with the unresolvedCompare marker.
test("declare-pr refuses unreadable required-check sources and leaves the run unchanged", async () => {
  const { repo } = await startRun();
  const before = await readRepoState(repo);
  const refused = await declareWith(repo, freePlanGh("1".repeat(40)));
  expect(refused.exitCode).toBe(1);
  expect(refused.payload.error).toContain("declare-pr is refused");
  expect(refused.payload.error).toContain("repository rulesets");
  expect(refused.payload.error).toContain("unresolvedCompare");
  expect(await readRepoState(repo)).toEqual(before);
});

// Usefulness: verifies a declaration on a readable repository, and one whose read fails for another
// reason, is unchanged, so only the unreadable-source case refuses.
test("declare-pr proceeds on a readable repository and on a failed read", async () => {
  const readable = await startRun();
  expect((await declareWith(readable.repo, prGateGh("1".repeat(40)))).exitCode).toBe(0);
  expect((await readRepoState(readable.repo)).pr).toBe(42);

  const failed = await startRun();
  expect((await declareWith(failed.repo, unreachableGh())).exitCode).toBe(0);
  expect((await readRepoState(failed.repo)).pr).toBe(42);
});

// The finishes below run on a repo whose `git` is answered from memory. A
// declared run with one accepted reviewer turn takes about twenty `git`
// processes to reach the finish: a repo, then a snapshot around each turn. A
// loaded Windows runner outlasted a test limit on that before the finish under
// test started (issue #385). The `role` code is real: the double replaces only
// the `git` child. Thus the dispatches, the snapshots, and the finish gate all
// run over the answers.

// Snapshot behavior against a real repo keeps its own tests. A directory stands
// in for the repo: the double answers for it, so it needs no `git` setup.
async function useDeclaredPrRun() {
  const repo = await useCleanRepo();
  await initPrRun(repo, 42);
  return { repo, head: CLEAN_REPO_HEAD };
}

async function useAcceptedPrRun() {
  const run = await useDeclaredPrRun();
  await dispatchReviewer(run.repo, ACCEPT);
  return run;
}

const REJECT = "Conclusion: fails.\nWhy: incomplete.\nBlockers: none.\nVerdict: reject";

/** Dispatches one worker turn in `repo` after the reviewer turn. */
function dispatchWorker(repo) {
  return executeRoleCommand(withRepo(dispatchArgv([], "worker"), repo), {
    agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
  });
}

const NO_GH = async () => {
  throw new Error("gh must not run: the gate refused locally.");
};

describe("finish on a run that declares a PR", () => {
  // Usefulness: verifies a declared run finishes on a base branch with no required
  // check, and records the absence in the envelope and the state file. Thus a
  // finish that verified no check stays distinguishable from one that verified a
  // check (issue #336).
  test("a declared PR finishes on a base branch with no required check", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const calls = [];
    const result = await finishCall(repo, ["--require-ci", "42"], {
      gh: noRequiredCheckGh(head, calls),
    });
    expect(result.exitCode).toBe(0);
    // The absence rests on the two fixtures this double names, so a route that
    // stops matching fails here instead of passing on a fallback.
    expect(calls).toEqual([
      pagedApiArgs("repos/owner/repo/rules/branches/main").join(" "),
      prChecksArgs(42).join(" "),
    ]);
    expect(result.payload).toMatchObject({ noRequiredChecks: true });
    const state = await readRepoState(repo);
    expect(state.lifecycle).toBe("finished");
    expect(state.noRequiredChecks).toBe(true);
  });

  // Usefulness: verifies a gated finish on a base branch that does require a check
  // records no absence. Thus the field means the branch had none rather than that
  // the gate ran (issue #336).
  test("a gated finish records no absence when the base branch requires a check", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: prGateGh(head) });
    expect(result.exitCode).toBe(0);
    expect(result.payload.noRequiredChecks).toBeUndefined();
    expect((await readRepoState(repo)).noRequiredChecks).toBeUndefined();
  });

  // Usefulness: verifies the same collect-then-report rule covers the completion
  // rule. Thus a declared PR run learns about the unmet reviewer turn and the
  // missing gate from one `finish` call (#302).
  test("a declared PR with no gate reports the completion rule and the gate in one refusal", async () => {
    await setup();
    const { repo } = await useDeclaredPrRun();

    const result = await finishCall(repo, ["--require-accept"], {
      gh: async () => {
        throw new Error("gh must not run: no gate was requested.");
      },
    });

    const gate =
      "this run declares PR 42, so a finish must end through the --require-ci 42 gate, and this run carries no --require-ci gate";
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toBe(
      `Finish refused: no reviewer turn after the latest worker turn; ${gate}.`,
    );
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies a run that declares a PR and gates the same PR behaves as
  // a gated run does today. Thus the declaration adds no second enforcement path
  // (#302).
  test("a declared PR with a matching gate finishes as the gate allows", async () => {
    await setup();
    const { repo, head } = await useAcceptedPrRun();

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: prGateGh(head) });
    expect(result.exitCode).toBe(0);
    expect((await readRepoState(repo)).lifecycle).toBe("finished");
  });

  // Usefulness: verifies the interactive gate names a worker turn after an accept, so the two
  // finish paths share one refusal reason (#1509).
  test("a worker turn after an accepted review names the turn order", async () => {
    await setup();
    const { repo } = await useAcceptedPrRun();
    await dispatchWorker(repo);

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: NO_GH });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain(
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
    );
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies the interactive gate names a worker turn after a reject too, so the
  // refusal does not depend on the verdict (#1509).
  test("a worker turn after a rejected review names the turn order", async () => {
    await setup();
    const { repo } = await useDeclaredPrRun();
    await dispatchReviewer(repo, REJECT);
    await dispatchWorker(repo);

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: NO_GH });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain(
      "a worker turn ran after the last review, and a reviewer turn on the current state must come before finish",
    );
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });

  // Usefulness: verifies a failed reviewer turn keeps the origin/main refusal when no worker turn
  // follows it, so only the turn order changes the wording (#1509).
  test("a failed reviewer turn keeps the no-reviewed-state refusal", async () => {
    await setup();
    const { repo } = await useDeclaredPrRun();
    await dispatchReviewer(repo, () => {
      throw new Error("reviewer CLI failed");
    });

    const result = await finishCall(repo, ["--require-ci", "42"], { gh: NO_GH });
    expect(result.exitCode).toBe(1);
    expect(result.payload.error).toContain("the latest reviewer turn has no reviewed state");
    expect(result.payload.error).not.toContain("a worker turn ran after the last review");
    expect((await readRepoState(repo)).lifecycle).toBe("active");
  });
});
