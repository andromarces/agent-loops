// Fixtures shared by the codex tests of the private per-turn temporary directory.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vite-plus/test";
import { runCodex } from "../../src/agents/codex.mjs";
import { exec } from "../../src/lib/exec.mjs";

export const TMP_VARS = ["TMPDIR", "TEMP", "TMP"];
export const OK_EVENTS = [
  { type: "thread.started", thread_id: "th-1" },
  { type: "item.completed", item: { type: "agent_message", text: "done" } },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

// Points the inherited temporary directory at `root` for `run`, then restores it. `runsRoot`
// moves the runs root, and with it the registry of turn directories, out of `root`, so a test that
// lists `root` sees only entries of the turn.
export async function withInheritedTmp(root, run, runsRoot) {
  const names = runsRoot === undefined ? TMP_VARS : [...TMP_VARS, "AGENT_LOOP_RUNS_ROOT"];
  const saved = names.map((name) => process.env[name]);
  for (const name of TMP_VARS) process.env[name] = root;
  if (runsRoot !== undefined) process.env.AGENT_LOOP_RUNS_ROOT = runsRoot;
  try {
    return await run();
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
}

// Stands in for the Codex CLI: it creates two empty `.tmpXXXXXX` directories in the temporary
// directory that it inherits, as the real CLI does on every `exec` turn, then runs `after`.
export function fakeCodex(after) {
  const seen = {};
  vi.mocked(exec).mockImplementationOnce(async (_cmd, _args, options) => {
    const env = options.env ?? {};
    seen.env = env;
    const home = env.TMPDIR ?? process.env.TMPDIR;
    seen.home = home;
    await mkdir(join(home, ".tmpAbC123"));
    await mkdir(join(home, ".tmpXyZ789"));
    return after ? after(home, env) : { stdout: OK_EVENTS, stderr: "" };
  });
  return seen;
}

export const runTurn = (options = {}) =>
  runCodex({ kind: "codex", sessionId: null, model: null, effort: null }, "p", {
    cwd: "/dir",
    ...options,
  });
