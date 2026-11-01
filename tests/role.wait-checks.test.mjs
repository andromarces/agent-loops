import { access, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { executeRoleCommand } from "../src/role.mjs";
import { statePaths } from "../src/lib/runstate.mjs";
import { cleanup, newRunRepo, repos, setup } from "./role-helpers.mjs";
import { parseRoleArgs } from "../src/role.mjs";
import { fakeClock, HEAD_A, HEAD_B, scriptedGh } from "./lib/check-wait-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";
import { pageStdout } from "./gh-doubles.mjs";

afterEach(cleanup);

const PENDING = { status: 8, checks: [{ name: "ci", state: "IN_PROGRESS", bucket: "pending" }] };
const SETTLED = { status: 0, checks: [{ name: "ci", state: "SUCCESS", bucket: "pass" }] };
const NO_REQUIRED_CHECKS_READ = {
  status: 1,
  stdout: "",
  stderr: "no required checks reported on the 'docs/212-adr-0024-agent-reads' branch",
};

// Usefulness: verifies `role wait-checks` prints one bounded envelope with the
// check states and creates no run state, so a parent can wait for the required
// checks before the first dispatch (issue #329).
test("wait-checks returns the check envelope and writes no run state", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([PENDING, SETTLED]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    head: HEAD_A,
    checks: SETTLED.checks,
  });
  await expect(access(statePaths({ cwd: repo }).stateFile)).rejects.toThrow();
});

// Usefulness: verifies `role wait-checks` on a branch with no required check
// prints `noRequiredChecks: true` with exit 0 and no `error`, so the parent reads
// a distinct outcome instead of a generic read error (issue #894).
test("wait-checks reports a branch with no required check as its own outcome", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "213", "--timeout", "60"]),
    {
      // Both sources state the absence: a ruleset reply with no required-status-check rule, and an
      // unprotected branch.
      gh: scriptedGh([NO_REQUIRED_CHECKS_READ], {
        rules: { status: 0, stdout: pageStdout([{ type: "deletion" }]), stderr: "" },
      }),
      ...fakeClock(),
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 213,
    timedOut: false,
    head: HEAD_A,
    noRequiredChecks: true,
    checks: [],
  });
});

// Usefulness: verifies `role wait-checks` exits 1 with `status: "error"` when `gh` answers that the
// branch has no required check but the rulesets cannot be read, as on the Free plan, so the wait
// never reports an absence that the `--require-ci` gate refuses (issue #1013).
test("wait-checks errors on the no-required-checks answer over an unreadable ruleset source", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "213", "--timeout", "60"]),
    {
      gh: scriptedGh([NO_REQUIRED_CHECKS_READ], {
        rules: {
          status: 1,
          stdout: "",
          stderr:
            "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
        },
      }),
      ...fakeClock(),
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toMatch(/repository rulesets/);
  expect(result.payload.noRequiredChecks).toBeUndefined();
});

// Usefulness: verifies exit 1 with only pending checks listed is unresolved, not a wait that
// runs to its bound: only exit 8 means pending, and exit 1 settles only on a listed failing
// check or the exact no-required-check answer (issue #894).
test("wait-checks keeps exit 1 with only pending checks unresolved", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    {
      gh: scriptedGh([{ status: 1, checks: PENDING.checks, stderr: "could not read the checks" }]),
      ...fakeClock(),
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.status).toBe("error");
  expect(result.payload.error).toMatch(/gh pr checks 42 --required could not be read/);
  expect(result.payload).not.toHaveProperty("checks");
  expect(result.payload).not.toHaveProperty("timedOut");
});

// Usefulness: verifies a wait that ends on its bound exits 0 and sets
// `timedOut`, so the parent reads the flag instead of losing the result to a
// harness command timeout (issue #329).
test("wait-checks reports the bound as reached when a required check is still pending", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([PENDING]), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: true,
    head: HEAD_A,
    checks: PENDING.checks,
  });
});

// Usefulness: verifies `--timeout 0` is refused, because the wait the issue adds
// exists to stay bounded and an unbounded wait is the outcome it prevents
// (issue #329).
test("wait-checks refuses an unbounded --timeout 0", async () => {
  const repo = await newRunRepo();

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
  const repo = await newRunRepo();

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
  const repo = await newRunRepo();
  const clock = { now: 0 };
  const bounds = [];
  const reads = scriptedGh([SETTLED]);

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      now: () => clock.now,
      // Validation spends 400ms of the one-second command bound.
      assertWorkTree: async () => {
        clock.now += 400;
      },
      gh: (args, cwd, { timeoutMs } = {}) => {
        bounds.push(timeoutMs);
        return reads(args, cwd);
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    head: HEAD_A,
    checks: SETTLED.checks,
  });
  // 1000ms of bound minus the 400ms validation, not a fresh 1000ms, on every read.
  expect(bounds.length).toBeGreaterThan(0);
  expect(new Set(bounds)).toEqual(new Set([600]));
});

// Usefulness: verifies the cancel signal of the command reaches the work-tree validation, so a
// canceled `wait-checks` does not wait for a stuck `git` (#729).
test("wait-checks hands its cancel signal to the work-tree validation", async () => {
  const repo = await newRunRepo();
  const controller = new AbortController();
  let received;

  await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      signal: controller.signal,
      assertWorkTree: async (cwd, options) => {
        received = options;
      },
      gh: async () => ({ status: 0, stdout: JSON.stringify(SETTLED.checks), stderr: "" }),
    },
  );
  expect(received.signal).toBe(controller.signal);
});

// Usefulness: verifies a bound spent before the first read reports the bound
// without reading, so a parent sees the bound it ran out of (issue #329).
test("wait-checks reports the bound when validation left none for the wait", async () => {
  const repo = await newRunRepo();
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
  expect(result.payload).toEqual({ status: "ok", pr: 42, timedOut: true, head: null, checks: [] });
  expect(read).toBe(false);
});

// Usefulness: verifies work-tree validation is inside the same total limit. A
// validation that never answers must not let the command run past its stated
// bound, and it must refuse rather than read from a work tree it never
// verified (issue #329).
test("wait-checks refuses when work-tree validation outlasts the bound", async () => {
  const repo = await newRunRepo();
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

// Usefulness: verifies `role wait-checks --all` on a PR whose branch has no required
// check waits for the listed checks of the head and prints them, so the parent can
// dispatch the reviewer after CI completes (issue #896).
test("wait-checks --all waits for the listed checks of the head", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--all", "--cwd", repo, "--pr", "42", "--timeout", "60"]),
    { gh: scriptedGh([PENDING, SETTLED], { all: true }), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    head: HEAD_A,
    checks: SETTLED.checks,
  });
});

// Usefulness: verifies `--all` is a wait-checks flag only, so a dispatch or finish
// that carries it fails loudly instead of ignoring it (issue #896).
test("--all is refused on an operation other than wait-checks", async () => {
  const result = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--all", "--cwd", "."]),
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toMatch(/--all is only valid for wait-checks/);
});

// Usefulness: verifies `role wait-checks --head <sha>` keeps waiting while the PR head
// is another commit and names the expected head in the envelope once it settles, so a
// parent that passes the worker `workTree.head` never reads the checks of the previous
// head (issue #961).
test("wait-checks --head waits for the PR head and names it in the envelope", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs([
      "wait-checks",
      "--cwd",
      repo,
      "--pr",
      "42",
      "--head",
      HEAD_B,
      "--timeout",
      "60",
    ]),
    { gh: scriptedGh([SETTLED], { heads: [HEAD_A, HEAD_B, HEAD_B] }), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({
    status: "ok",
    pr: 42,
    timedOut: false,
    head: HEAD_B,
    checks: SETTLED.checks,
  });
});

// Usefulness: verifies a `--head` wait that reaches its bound before the PR head moves
// reports `timedOut: true` with no head and no checks, never a pass (issue #961).
test("wait-checks --head reports the bound when the PR head never reaches it", async () => {
  const repo = await newRunRepo();

  const result = await executeRoleCommand(
    parseRoleArgs([
      "wait-checks",
      "--cwd",
      repo,
      "--pr",
      "42",
      "--head",
      HEAD_B,
      "--timeout",
      "30",
    ]),
    { gh: scriptedGh([SETTLED], { heads: [HEAD_A] }), ...fakeClock() },
  );
  expect(result.exitCode).toBe(0);
  expect(result.payload).toEqual({ status: "ok", pr: 42, timedOut: true, head: null, checks: [] });
});

// Usefulness: verifies `--head` takes only a full commit SHA and only `wait-checks`, so an
// abbreviation that equals no head cannot make a wait that never settles (issue #961).
test("--head refuses an abbreviation and any operation but wait-checks", () => {
  expect(() => parseRoleArgs(["wait-checks", "--pr", "42", "--head", "abc123"])).toThrow(
    /--head must be a full lowercase commit SHA/,
  );
  expect(() =>
    parseRoleArgs(["wait-checks", "--pr", "42", "--head", HEAD_A.toUpperCase()]),
  ).toThrow(/--head must be a full lowercase commit SHA/);
});

// Usefulness: verifies `--head` is refused on an operation other than wait-checks, so a
// dispatch that carries it fails loudly instead of ignoring it (issue #961).
test("--head is refused on an operation other than wait-checks", async () => {
  const result = await executeRoleCommand(
    parseRoleArgs(["dispatch", "--role", "worker", "--head", HEAD_A, "--cwd", "."]),
    {},
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload.error).toMatch(/--head is only valid for wait-checks/);
});

// Usefulness: verifies the error envelope of `role wait-checks` carries `childExitUnconfirmed`
// when a sibling read of the failed poll stays unconfirmed, so the parent settles the `gh`
// process before another wait (issue #961).
test("wait-checks marks an error envelope with an unconfirmed child", async () => {
  const repo = await newRunRepo();
  const inner = scriptedGh([SETTLED], { commits: { [HEAD_A]: SETTLED.checks } });

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      gh: (args, cwd, options) => {
        if (args[0] === "api" && args[1].includes("/rules/branches/")) {
          return Promise.resolve({ status: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" });
        }
        if (args[0] === "api" && args[1].includes("/protection")) {
          return new Promise(() => {});
        }
        return inner(args, cwd, options);
      },
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ status: "error", childExitUnconfirmed: true });
}, 20000);

// Usefulness: verifies `--expect` parses as a repeatable flag and is refused without `--all`
// and on every other operation, so the option never silently does nothing (issue #978).
test("wait-checks takes a repeatable --expect only with --all", async () => {
  expect(
    parseRoleArgs(["wait-checks", "--pr", "1", "--all", "--expect", "a", "--expect", "b"]).expect,
  ).toEqual(["a", "b"]);
  const repo = await newRunRepo();
  const noAll = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "1", "--expect", "a"]),
    { gh: scriptedGh([SETTLED]), ...fakeClock() },
  );
  expect(noAll.exitCode).toBe(1);
  expect(noAll.payload.error).toMatch(/--expect needs --all/);
  const misplaced = await executeRoleCommand(
    parseRoleArgs(["finish", "--cwd", repo, "--expect", "a"]),
    {},
  );
  expect(misplaced.exitCode).toBe(1);
  expect(misplaced.payload.error).toMatch(/--expect is only valid for wait-checks/);
});

// Usefulness: verifies a transport failure that lasts to the bound exits 1 with `status: "error"`
// that names it, never `timedOut: true` and never a pass (issue #1312).
test("wait-checks reports a transport failure that lasts to the bound as an error", async () => {
  const repo = await newRunRepo();
  const inner = scriptedGh([SETTLED], { commits: { [HEAD_A]: SETTLED.checks } });

  const result = await executeRoleCommand(
    parseRoleArgs(["wait-checks", "--cwd", repo, "--pr", "42", "--timeout", "1"]),
    {
      gh: (args, cwd, options) => {
        if (args[0] === "api" && args[1].includes("/rules/branches/")) {
          return Promise.resolve({
            status: 1,
            stdout: "",
            stderr:
              'Get "https://api.github.com/repos/owner/repo/rules/branches/main": dial tcp 20.205.243.168:443: connect: operation timed out',
          });
        }
        return inner(args, cwd, options);
      },
      ...fakeClock(),
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.payload).toMatchObject({ status: "error" });
  expect(result.payload.error).toMatch(/dial tcp .*connect: operation timed out/);
  expect(result.payload).not.toHaveProperty("timedOut");
}, 20000);
