import { afterEach, expect, test, vi } from "vite-plus/test";
import { SPAWNED_RUN_ENV, exec } from "../src/lib/exec.mjs";
import { snapshot } from "../src/lib/snapshot.mjs";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  readRepoState,
  recordingAdapter,
  startRun as startRunWith,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { freePlanGh, PASSING_RUN, prGateGh, unreachableGh } from "./gh-doubles.mjs";

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllEnvs();
});

const SUMMARY = { changed: "a", verified: "b", deferred: "c", notDone: "d", open: "e" };
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
const startRun = (options) => startRunWith({ gh: prGateGh("1".repeat(40)), ...options });

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
  const script = `console.log(process.env.${SPAWNED_RUN_ENV})`;
  const spawned = await exec(process.execPath, ["-e", script], { role: "worker", cwd: repo });
  vi.stubEnv(SPAWNED_RUN_ENV, spawned.stdout.trim());
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
