import { access, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
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

// Usefulness: verifies the bound starts at command entry, not at the first
// check read. Work-tree validation runs inside the command, so the read is
// bounded by what is left of the command bound rather than by a fresh full
// bound (issue #329).
test("wait-checks spends work-tree validation inside the bound", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const clock = { now: 0 };
  const bounds = [];

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      now: () => clock.now,
      // Validation spends 400ms of the one-second command bound.
      assertWorkTree: async () => {
        clock.now += 400;
      },
      gh: async (args, cwd, { timeoutMs } = {}) => {
        bounds.push(timeoutMs);
        return { status: 0, stdout: JSON.stringify(SETTLED.checks), stderr: "" };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    checks: SETTLED.checks,
  });
  // 1000ms of bound minus the 400ms validation, not a fresh 1000ms.
  expect(bounds).toEqual([600]);
});

// Usefulness: verifies a bound spent before the first read reports the bound
// without reading, so a parent sees the bound it ran out of (issue #329).
test("wait-checks reports the bound when validation left none for the wait", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  const clock = { now: 0 };
  let read = false;

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      now: () => clock.now,
      assertWorkTree: async () => {
        clock.now += 5000;
      },
      gh: async () => {
        read = true;
        return { status: 8, stdout: JSON.stringify(PENDING.checks), stderr: "" };
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({ status: "ok", pr: 42, timedOut: true, checks: [] });
  expect(read).toBe(false);
});

// Usefulness: verifies work-tree validation is inside the same total limit. A
// validation that never answers must not let the command run past its stated
// bound, and it must refuse rather than read from a work tree it never
// verified (issue #329).
test("wait-checks refuses when work-tree validation outlasts the bound", async () => {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  let read = false;
  const started = Date.now();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      // Never answers, as a hung `git` call does.
      assertWorkTree: () => new Promise(() => {}),
      gh: async () => {
        read = true;
        return { status: 0, stdout: JSON.stringify(SETTLED.checks), stderr: "" };
      },
    },
  );
  const elapsed = Date.now() - started;
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toMatch(/validation/);
  // The command stops on its own bound, not on the harness command timeout.
  expect(elapsed).toBeLessThan(6000);
  expect(read).toBe(false);
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

// Usefulness: verifies the `--cwd` guard does not refuse a Git work tree whose
// path contains spaces, which would otherwise block every wait in such a work
// tree (issue #413).
test("wait-checks does not refuse a Git work tree whose path contains spaces", async () => {
  await setup();
  const parent = await mkdtemp(join(tmpdir(), "wait checks spaced parent-"));
  repos.push(parent);
  const source = await createTempRepo();
  repos.push(source);
  const repo = join(parent, "my work tree");
  await rename(source, repo);

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([SETTLED]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toMatchObject({ status: "ok", pr: 42, timedOut: false });
});
