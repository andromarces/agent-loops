import { access } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { decideParentGuard } from "../src/hook/decision.mjs";
import { statePaths, writeState } from "../src/lib/runstate.mjs";
import { executeRoleCommand } from "../src/role.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  readRepoState,
  recordingAdapter,
  repos,
  setup,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

const OLD = "parent-sess-1";
const NEW = "parent-sess-2";
const adoptArgv = (...flags) => ["adopt", "--cwd", "<repo>", ...flags];
const ownerAdoptArgv = (...flags) =>
  adoptArgv("--from-session", OLD, "--parent-session", NEW, ...flags);

async function startRun(agents) {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  await executeRoleCommand(withRepo(dispatchArgv([...INIT_OVERRIDES, "--max-steps", "5"]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  return repo;
}

const freshAgents = () => ({ fake1: recordingAdapter([]), fake2: recordingAdapter([]) });

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

// Usefulness: verifies acceptance — after adopt the new session's parent-edit
// guard covers the run and the old session's guard releases it (issue #435).
test("adopt moves the guard from the old parent session to the new one", async () => {
  const repo = await startRun(freshAgents());
  expect((await decideParentGuard(OLD)).decision).toBe("deny");
  expect((await decideParentGuard(NEW)).decision).toBe("allow");

  const result = await executeRoleCommand(withRepo(ownerAdoptArgv(), repo));
  expect(result.exitCode).toBe(0);
  expect(result.payload).toMatchObject({ status: "ok", lifecycle: "active" });

  expect((await decideParentGuard(NEW)).decision).toBe("deny");
  expect((await decideParentGuard(OLD)).decision).toBe("allow");
  expect(await exists(statePaths({ cwd: repo, parentSession: OLD }).sessionEntryFile)).toBe(false);
});

// Usefulness: verifies the run continues for the new parent on the same state
// file, with the stored role session, and that the old id is no longer accepted
// by extend (issue #435).
test("adopt hands the run to the new session for dispatch and extend", async () => {
  const worker = recordingAdapter([]);
  const agents = { fake1: worker, fake2: recordingAdapter([]) };
  const repo = await startRun(agents);
  await executeRoleCommand(withRepo(ownerAdoptArgv(), repo));

  const next = await executeRoleCommand(withRepo(dispatchArgv(["--parent-session", NEW]), repo), {
    agents,
    stdin: stdinPrompt,
  });
  expect(next.exitCode).toBe(0);
  expect(worker.recorded[1].incomingSessionId).toBe("sess-1");

  const stale = await executeRoleCommand(
    withRepo(["extend", "--cwd", "<repo>", "--parent-session", OLD, "--max-steps", "9"], repo),
  );
  expect(stale.exitCode).toBe(1);
  const fresh = await executeRoleCommand(
    withRepo(["extend", "--cwd", "<repo>", "--parent-session", NEW, "--max-steps", "9"], repo),
  );
  expect(fresh.exitCode).toBe(0);
});

// Usefulness: verifies the change is recorded like budgetChanges, beside an
// intact state (issue #435).
test("adopt records the change in parentChanges", async () => {
  const repo = await startRun(freshAgents());
  const before = await readRepoState(repo);
  await executeRoleCommand(withRepo(ownerAdoptArgv(), repo));
  const state = await readRepoState(repo);
  expect(state.parentSession).toBe(NEW);
  expect(state.parentChanges).toEqual([
    { from: OLD, to: NEW, stepsUsed: before.stepsUsed, at: expect.any(String) },
  ]);
  expect(state.stepsUsed).toBe(before.stepsUsed);
  expect(state.lifecycle).toBe(before.lifecycle);
});

// Usefulness: verifies adopt cannot revive or capture a finished run, and needs
// a run at the work tree (issue #435).
test("adopt refuses a terminal run and a path with no run state", async () => {
  const repo = await startRun(freshAgents());
  await executeRoleCommand(withRepo(["abort", "--cwd", "<repo>", "--reason", "stop"], repo));
  const ended = await executeRoleCommand(withRepo(ownerAdoptArgv(), repo));
  expect(ended.exitCode).toBe(1);
  expect(ended.payload.error).toBe("Run is already aborted.");
  expect((await readRepoState(repo)).parentSession).toBe(OLD);

  const other = await createTempRepo();
  repos.push(other);
  const none = await executeRoleCommand(withRepo(ownerAdoptArgv(), other));
  expect(none.payload.error).toContain("No run state");
});

// Usefulness: verifies the child-role boundary matches extend — a call that
// omits the stored id or carries another one cannot take the guard, and the
// refusal does not leak the stored id (issue #435).
test("adopt refuses a call without the stored parent session id", async () => {
  const repo = await startRun(freshAgents());
  const cases = [
    [["--parent-session", "child-sess-9"], "adopt requires --from-session"],
    [["--from-session", "child-sess-9", "--parent-session", NEW], "does not match"],
    [["--from-session", OLD], "adopt requires --parent-session"],
    [["--from-session", OLD, "--parent-session", OLD], "already the run's parent session"],
    [["--from-session", OLD, "--parent-session", "${X}"], "Invalid session id"],
  ];
  for (const [flags, message] of cases) {
    const result = await executeRoleCommand(withRepo(adoptArgv(...flags), repo));
    expect(result.exitCode, message).toBe(1);
    expect(result.payload.error, message).toContain(message);
    expect(JSON.stringify(result.payload), message).not.toContain(OLD);
  }
  const state = await readRepoState(repo);
  expect(state.parentSession).toBe(OLD);
  expect(state.parentChanges).toBeUndefined();
  expect((await decideParentGuard(OLD)).decision).toBe("deny");
});

// Usefulness: verifies adopt takes only the two session flags: dispatch, abort,
// and finish flags and a changed init field are refused, and --from-session is
// refused on every other operation (issue #435).
test("adopt and other operations refuse flags that belong elsewhere", async () => {
  const repo = await startRun(freshAgents());
  const cases = [
    [ownerAdoptArgv("--role", "worker"), "--role is only valid for dispatch"],
    [ownerAdoptArgv("--reason", "x"), "--reason is only valid for abort"],
    [ownerAdoptArgv("--require-accept"), "only valid for finish"],
    [ownerAdoptArgv("--worker", "fake2"), "--worker cannot be changed after init"],
    [
      ["extend", "--cwd", "<repo>", "--from-session", OLD],
      "--from-session is only valid for adopt",
    ],
    [dispatchArgv(["--from-session", OLD]), "--from-session is only valid for adopt"],
  ];
  for (const [argv, message] of cases) {
    const result = await executeRoleCommand(withRepo(argv, repo));
    expect(result.exitCode, message).toBe(1);
    expect(result.payload.error, message).toContain(message);
  }
  expect((await readRepoState(repo)).parentSession).toBe(OLD);
});

// Usefulness: verifies adopt works on an interrupted run and leaves the
// lifecycle as it is (issue #435).
test("adopt leaves an interrupted lifecycle unchanged", async () => {
  const repo = await startRun(freshAgents());
  const state = await readRepoState(repo);
  state.lifecycle = "interrupted";
  await writeState(statePaths({ cwd: repo }).stateFile, state);
  const result = await executeRoleCommand(withRepo(ownerAdoptArgv(), repo));
  expect(result.payload).toMatchObject({ status: "ok", lifecycle: "interrupted" });
  expect((await decideParentGuard(NEW)).decision).toBe("deny");
});
