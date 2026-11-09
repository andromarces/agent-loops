import { afterEach, expect, vi } from "vite-plus/test";

// Answers `git` from memory, so each case starts no `git` process. See `cleanRepoGit`.
const gitDouble = vi.hoisted(() => ({ answer: null }));
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      const answer =
        gitDouble.answer && command === "git" ? gitDouble.answer(command, args, options) : null;
      return answer ?? real.execa(command, args, options);
    },
  };
});

import { executeRoleCommand } from "../src/role/index.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newCleanRunRepo,
  readRepoState,
  recordingAdapter,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { createBarrierTest } from "./barrier-helpers.mjs";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

afterEach(async () => {
  gitDouble.answer = null;
  await cleanup();
});

/** A `gh` double that answers only the PR list read of the worker envelope. */
function prListGh({ entries = [], status = 0, stdout } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] !== "pr" || args[1] !== "list") {
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    }
    return {
      status,
      stdout: stdout ?? JSON.stringify(entries),
      stderr: status === 0 ? "" : "gh: read failed",
    };
  };
  gh.calls = calls;
  return gh;
}

const agents = () => ({ fake1: recordingAdapter([]), fake2: recordingAdapter([]) });

// Usefulness: verifies a worker turn that opens a PR carries its number and head in the envelope
// and the state. The parent then reads no free text for the PR source.
test("a worker turn carries the open PR of its branch", async () => {
  const repo = await newCleanRunRepo(gitDouble);
  const gh = prListGh({
    entries: [{ number: 1755, headRefOid: HEAD, isCrossRepository: false }],
  });

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: agents(),
    stdin: stdinPrompt,
    gh,
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.workTree.pr).toEqual({ number: 1755, head: HEAD });
  expect((await readRepoState(repo)).lastResult.workTree.pr).toEqual({
    number: 1755,
    head: HEAD,
  });
  const [args] = gh.calls;
  expect(args.slice(0, 3)).toEqual(["pr", "list", "--head"]);
  expect(args.slice(4, 6)).toEqual(["--state", "open"]);
  expect(args).toContain("number,headRefOid,isCrossRepository");
});

// Usefulness: verifies a worker turn with no open PR carries no field and stays ok.
test("a worker turn with no open PR carries no field and stays ok", async () => {
  const repo = await newCleanRunRepo(gitDouble);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: agents(),
    stdin: stdinPrompt,
    gh: prListGh({ entries: [] }),
  });

  expect(result.exitCode).toBe(0);
  expect(result.payload.status).toBe("ok");
  expect(result.payload.workTree).not.toHaveProperty("pr");
});

// Usefulness: verifies a failed PR read carries no field, logs one warning, and keeps the turn ok.
test("a failed PR read carries no field and keeps the turn ok", async () => {
  const repo = await newCleanRunRepo(gitDouble);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
      agents: agents(),
      stdin: stdinPrompt,
      gh: prListGh({ status: 1 }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.payload.status).toBe("ok");
    expect(result.payload.workTree).not.toHaveProperty("pr");
    const warnings = errorSpy.mock.calls.map((call) => call.join(" "));
    expect(warnings.some((line) => line.includes("work tree PR read failed"))).toBe(true);
  } finally {
    errorSpy.mockRestore();
  }
});

// Usefulness: verifies a reviewer turn reads no PR, so the field belongs to the worker only.
test("a reviewer turn reads no PR", async () => {
  const repo = await newCleanRunRepo(gitDouble);
  await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: agents(),
    stdin: stdinPrompt,
    gh: prListGh({ entries: [] }),
  });
  const reviewerGh = vi.fn(async () => {
    throw new Error("the reviewer turn read a PR");
  });

  const result = await executeRoleCommand(withRepo(dispatchArgv([], "reviewer"), repo), {
    agents: agents(),
    stdin: stdinPrompt,
    gh: reviewerGh,
  });

  expect(result.exitCode).toBe(0);
  expect(reviewerGh).not.toHaveBeenCalled();
  expect(result.payload.workTree).toBeUndefined();
});
