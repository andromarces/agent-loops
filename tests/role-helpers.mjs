import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePaths } from "../src/lib/runstate.mjs";
import { parseRoleArgs } from "../src/role.mjs";

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

/** Deps for calls whose child turn is not under assertion. */
export const basicDeps = () => ({
  agents: { fake1: recordingAdapter([]), fake2: recordingAdapter([]) },
  stdin: stdinPrompt,
});

export async function readRepoState(repo) {
  return JSON.parse(await readFile(statePaths({ cwd: repo }).stateFile, "utf8"));
}

// Each test gets its own runs root (env override) and its own temp repo, so
// state files never collide between tests. Callers push repos to `repos` and
// pass `cleanup` to `afterEach`.
let runsRoot;
export const repos = [];

export async function setup() {
  runsRoot = await mkdtemp(join(tmpdir(), "role-test-runs-"));
  process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
  return runsRoot;
}

export async function cleanup() {
  delete process.env.AGENT_LOOP_RUNS_ROOT;
  for (const dir of repos) {
    await rm(dir, { recursive: true, force: true });
  }
  repos.length = 0;
  await rm(runsRoot, { recursive: true, force: true });
  runsRoot = undefined;
}
