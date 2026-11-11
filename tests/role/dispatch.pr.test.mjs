import { afterEach, expect, vi } from "vite-plus/test";
import { execa } from "execa";
import { executeRoleCommand } from "../../src/role/index.mjs";
import { runGh } from "../../src/lib/checks/gh-api.mjs";
import {
  cleanup,
  dispatchArgv,
  INIT_OVERRIDES,
  newRunRepo,
  readRepoState,
  recordingAdapter,
  stdinPrompt,
  withRepo,
  WORKER_REPLY,
} from "./helpers.mjs";
import { createBarrierTest } from "../barrier-helpers.mjs";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Every test body runs through a body barrier (issue #943)
const test = createBarrierTest();

afterEach(cleanup);

/** A `gh` double that answers the repository and PR list reads of the worker envelope. */
function prListGh({ entries = [], status = 0, stdout } = {}) {
  const calls = [];
  const gh = async (args, cwd, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "repo" && args[1] === "view") {
      return { status: 0, stdout: "owner/repo\n", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return {
        status,
        stdout: stdout ?? (status === 0 ? JSON.stringify(entries) : ""),
        stderr: status === 0 ? "" : "gh: read failed",
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  gh.calls = calls;
  return gh;
}

const agents = () => ({ fake1: recordingAdapter([]), fake2: recordingAdapter([]) });

// Usefulness: verifies a worker turn that opens a PR carries its number and head in the envelope
// and the state. The parent then reads no free text for the PR source.
test("a worker turn carries the open PR of its branch", async () => {
  const repo = await newRunRepo();
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
  const listCall = gh.calls.find((call) => call.args[0] === "pr");
  expect(listCall.args.slice(0, 5)).toEqual(["pr", "list", "--repo", "owner/repo", "--head"]);
  expect(listCall.args.slice(6, 8)).toEqual(["--state", "open"]);
  expect(listCall.args).toContain("number,headRefOid,isCrossRepository");
});

// Usefulness: verifies a worker turn with no open PR carries no field and stays ok.
test("a worker turn with no open PR carries no field and stays ok", async () => {
  const repo = await newRunRepo();

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
  const repo = await newRunRepo();
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

// Usefulness: verifies a cancel during the PR read keeps the turn evidence. The turn exits 130
// with the interrupted lifecycle, not an ok turn.
test("a cancel during the PR read keeps the turn evidence and exits 130", async () => {
  const repo = await newRunRepo();
  const controller = new AbortController();
  const gh = async (args, cwd, options = {}) => {
    controller.abort();
    return runGh(args, cwd, options);
  };
  const worker = recordingAdapter([
    async (_state, _prompt, options) => {
      await execa("git", ["config", "user.name", "Envelope Probe"], { cwd: options.cwd });
      return WORKER_REPLY;
    },
  ]);

  const result = await executeRoleCommand(withRepo(dispatchArgv(INIT_OVERRIDES), repo), {
    agents: { fake1: worker, fake2: recordingAdapter([]) },
    stdin: stdinPrompt,
    gh,
    signal: controller.signal,
  });

  expect(result.exitCode).toBe(130);
  expect(result.payload.status).toBe("error");
  expect(result.payload.sharedGitChanged).toContain("user.name");
  const state = await readRepoState(repo);
  expect(state.lifecycle).toBe("interrupted");
  expect(state.lastResult.sharedGitChanged).toContain("user.name");
});

// Usefulness: verifies a reviewer turn reads no PR, so the field belongs to the worker only.
test("a reviewer turn reads no PR", async () => {
  const repo = await newRunRepo();
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
