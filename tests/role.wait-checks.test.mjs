import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { executeRoleCommand } from "../src/role.mjs";
import { statePaths } from "../src/lib/runstate.mjs";
import { cleanup, repos, setup } from "./role-helpers.mjs";
import { parseRoleArgs } from "../src/role.mjs";
import { createTempRepo } from "./runtime-helpers.mjs";

afterEach(cleanup);

// Reads `--required` checks: each entry is `{ status, checks }`, and the last
// entry repeats, so a wait that polls more times than the script holds answers.
function scriptedGh(reads) {
  let n = 0;
  return async () => {
    const read = reads[Math.min(n++, reads.length - 1)];
    return { status: read.status, stdout: JSON.stringify(read.checks), stderr: "" };
  };
}

// A fake clock, so a wait that runs to its bound finishes the test at once.
function fakeClock() {
  const clock = { now: 0 };
  return {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
}

const PENDING = { status: 8, checks: [{ name: "ci", state: "IN_PROGRESS", bucket: "pending" }] };
const SETTLED = { status: 0, checks: [{ name: "ci", state: "SUCCESS", bucket: "pass" }] };

// Usefulness: verifies `role wait-checks` prints one bounded envelope with the
// check states and creates no run state, so a parent can wait for the required
// checks before the first dispatch (issue #329).
test("wait-checks returns the check envelope and writes no run state", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([PENDING, SETTLED]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    checks: SETTLED.checks,
  });
  await expect(access(statePaths({ cwd: repo }).stateFile)).rejects.toThrow();
});

// Usefulness: verifies a wait that ends on its bound exits 0 and sets
// `timedOut`, so the parent reads the flag instead of losing the result to a
// harness command timeout (issue #329).
test("wait-checks reports the bound as reached when a required check is still pending", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([PENDING]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({ status: "ok", pr: 42, timedOut: true, checks: PENDING.checks });
});

// Usefulness: verifies `--timeout 0` is refused, because the wait the issue adds
// exists to stay bounded and an unbounded wait is the outcome it prevents
// (issue #329).
test("wait-checks refuses an unbounded --timeout 0", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "0"]),
    { gh: scriptedGh([SETTLED]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toMatch(/--timeout/);
});

// Usefulness: verifies `wait-checks` names the pull request it waits for, since
// the operation reads checks and nothing else (issue #329).
test("wait-checks refuses a call with no --pr", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);

  const result = await executeRoleCommand(parseRoleArgs(["wait-checks", "--cwd", repo]), {
    gh: scriptedGh([SETTLED]),
    ...fakeClock(),
  });
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toMatch(/--pr/);
});

// Usefulness: verifies a `--cwd` outside a Git work tree is refused before any
// read, with the same message `dispatch` uses, so an invalid work tree cannot
// read checks (issue #329).
test("wait-checks refuses a --cwd outside a Git work tree", async () => {
  await setup();
  const outside = await mkdtemp(join(tmpdir(), "wait-checks-outside-"));
  repos.push(outside);
  let read = false;

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", outside, "--pr", "42", "--timeout", "60"]),
    {
      gh: async () => {
        read = true;
        return { status: 8, stdout: JSON.stringify(PENDING), stderr: "" };
      },
      ...fakeClock(),
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toMatch(/must be inside a Git work tree/);
  // A refused work tree is refused before the read, not after it.
  expect(read).toBe(false);
});
