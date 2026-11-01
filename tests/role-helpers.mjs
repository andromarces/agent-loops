import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import { statePaths } from "../src/lib/runstate.mjs";
import { executeRoleCommand, parseRoleArgs } from "../src/role.mjs";
import { restoreRunsRoot } from "./env-helpers.mjs";
import { removePath } from "./fs-helpers.mjs";
import { createTempRepo } from "./git-helpers.mjs";
import { prGateGh } from "./gh-doubles.mjs";

export const REPORT = "Conclusion: done\nWhy: tests pass\nBlockers: none";
export const WORKER_REPLY = `${REPORT}\nContinuing next turn.`;

/**
 * Records adapter calls and replays queued replies; assigns a session id once.
 * An exhausted queue falls back to `WORKER_REPLY`.
 */
export function recordingAdapter(replies) {
  let n = 0;
  return {
    recorded: [],
    async run(state, prompt, options) {
      this.recorded.push({ incomingSessionId: state.sessionId, prompt, options });
      if (!state.sessionId) {
        state.sessionId = `sess-${++n}`;
      }
      const reply = replies.length > 0 ? replies.shift() : WORKER_REPLY;
      return typeof reply === "function" ? reply(state, prompt, options) : reply;
    },
  };
}

// Init-only flags for the first (initializing) dispatch call, including the
// role agent configuration that later calls must read from the state file.
export const INIT_OVERRIDES = [
  "--task",
  "Fix the flaky test.",
  "--mode",
  "work-first",
  "--parent-session",
  "parent-sess-1",
  "--worker",
  "fake1",
  "--reviewer",
  "fake2",
];

export function dispatchArgv(overrides = [], role = "worker") {
  return ["dispatch", "--role", role, "--cwd", "<repo>", ...overrides];
}

export function withRepo(args, repo) {
  return parseRoleArgs(args.map((value) => (value === "<repo>" ? repo : value)));
}

export const stdinPrompt = async () => "continue working";

/** Dispatches one reviewer turn in `repo`, with the stub prompt on stdin. */
export const reviewerTurn = (repo, agents, overrides = []) =>
  executeRoleCommand(withRepo(dispatchArgv(overrides, "reviewer"), repo), {
    agents,
    stdin: stdinPrompt,
  });

/** Deps for calls whose child turn is not under assertion. `gh` answers the start read of a declared PR. */
export const basicDeps = () => ({
  agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
  stdin: stdinPrompt,
  gh: prGateGh("1".repeat(40)),
});

export async function readRepoState(repo) {
  return JSON.parse(await readFile(statePaths({ cwd: repo }).stateFile, "utf8"));
}

// Each test gets its own runs root (env override) and its own temp repo, so
// state files never collide between tests. Callers push repos to `repos` and
// pass `cleanup` to `afterEach`.
// A test can call `setup` more than once; `cleanup` removes every root created.
const runsRoots = [];
export const repos = [];

// Counts cleanups. A `setup` that resumes after a `cleanup` belongs to a finished case (for example
// one that timed out), so it removes its own root and rejects instead of replacing the root of the
// case that runs now.
let generation = 0;

export async function setup() {
  const started = generation;
  const runsRoot = await mkdtemp(join(tmpdir(), "role-test-runs-"));
  if (started !== generation) {
    await removePath(runsRoot);
    throw new Error("setup resumed after cleanup: its test case has ended.");
  }
  runsRoots.push(runsRoot);
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
  return runsRoot;
}

/** Starts a test case: a fresh runs root and a temp repo that `cleanup` removes. */
export async function newRunRepo() {
  await setup();
  const repo = await createTempRepo();
  repos.push(repo);
  return repo;
}

/**
 * Initializes a run in `repo` with the standard init flags plus `initFlags`.
 * The `gh` stub answers the start read of a declared PR. Returns the adapters the run used.
 */
export async function initRun(
  repo,
  { initFlags = [], role = "worker", agents = defaultAgents(), gh = undefined } = {},
) {
  await executeRoleCommand(withRepo(dispatchArgv([...INIT_OVERRIDES, ...initFlags], role), repo), {
    agents,
    stdin: stdinPrompt,
    ...(gh && { gh }),
  });
  return agents;
}

/** Starts a run in a new work tree under a fresh runs root. */
export async function startRun(options = {}) {
  const repo = await newRunRepo();
  return { repo, agents: await initRun(repo, options) };
}

const defaultAgents = () => ({ fake1: recordingAdapter([]), fake2: recordingAdapter([]) });

export async function cleanup() {
  generation += 1;
  restoreRunsRoot();
  for (const dir of repos) {
    await removePath(dir);
  }
  repos.length = 0;
  for (const root of runsRoots.splice(0)) {
    await removePath(root);
  }
}

/**
 * Replaces `process.stdout.write` with a recorder for the main entry point. A
 * `failure` is reported the way a broken pipe is: through the write callback,
 * or by throwing when `throws` is set. With `emitsErrorEvent`, the failure is
 * also emitted as a stream 'error' event on the next tick, as Node does, and
 * `spy.unhandledErrorEvents` counts the emits that had no listener. Restore
 * with `spy.mockRestore()`.
 */
export function spyStdoutWrite({ failure = null, throws = false, emitsErrorEvent = false } = {}) {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk, callback) => {
    if (failure && throws) {
      throw failure;
    }
    callback?.(failure);
    if (failure && emitsErrorEvent) {
      process.nextTick(() => {
        if (process.stdout.listenerCount("error") === 0) {
          spy.unhandledErrorEvents++;
        } else {
          process.stdout.emit("error", failure);
        }
      });
    }
    return true;
  });
  spy.unhandledErrorEvents = 0;
  return spy;
}

/** Waits past the next-tick queue and the immediate queue. */
export const settleStreamEvents = () => new Promise((resolve) => setImmediate(resolve));
