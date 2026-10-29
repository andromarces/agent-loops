import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { executeRoleCommand } from "../src/role.mjs";
import {
  basicDeps,
  cleanup,
  dispatchArgv,
  newRunRepo,
  readRepoState,
  stdinPrompt,
  withRepo,
} from "./role-helpers.mjs";
import { processExists, removePath } from "./runtime-helpers.mjs";

const ROLE = fileURLToPath(new URL("../src/role.mjs", import.meta.url));
const scratches = [];
// Every spawned dispatch, so teardown ends it on every path, a startup timeout included.
const dispatches = [];

// The pid that a fake `codex` of `scratch` reported, or null when it never got that far.
async function reportedPid(scratch) {
  const report = JSON.parse(
    await readFile(join(scratch, "report.json"), "utf8").catch(() => "null"),
  );
  return report?.pid ?? null;
}

afterEach(async () => {
  for (const child of dispatches.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const dir of scratches) {
    const pid = await reportedPid(dir);
    if (pid !== null && processExists(pid)) process.kill(pid, "SIGKILL");
  }
  await cleanup();
  for (const dir of scratches.splice(0)) await removePath(dir);
});

// A fake `codex` that reports its temporary directory and pid, leaves a file in that directory,
// and then hangs, so a test can kill the dispatch that owns it mid-turn.
const FAKE_CODEX = `
const fs = require("fs");
const dir = process.env.TMPDIR;
fs.writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ pid: process.pid, dir }));
fs.writeFileSync(dir + "/leftover.txt", "x");
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 60000);
`;

/**
 * Starts a real `role dispatch` whose Codex turn hangs and kills the dispatch with SIGKILL mid-turn,
 * once the state file holds the child of the turn. The orphaned fake `codex` is ended unless
 * `keepChild` is set, and teardown ends it either way. Returns the work tree, the temporary
 * directory of the turn (as the turn child saw it), the temporary root that holds it, and the pid
 * of the fake `codex`.
 */
async function killedDispatch({ keepChild = false } = {}) {
  const repo = await newRunRepo();
  const scratch = await mkdtemp(join(tmpdir(), "dead-turn-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  const tmpRoot = join(scratch, "tmp");
  mkdirSync(bin);
  mkdirSync(tmpRoot);
  const script = join(bin, "fake-codex.cjs");
  const report = join(scratch, "report.json");
  const promptFile = join(scratch, "prompt.txt");
  await writeFile(script, FAKE_CODEX, "utf8");
  await writeFile(promptFile, "work it", "utf8");
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), `@echo off\r\nnode "${script}"\r\n`);
  } else {
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec node '${script}'\n`, { mode: 0o755 });
  }
  const runner = [
    `import { main } from ${JSON.stringify(pathToFileURL(ROLE).href)};`,
    "await main(process.argv.slice(1));",
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      runner,
      "--",
      "dispatch",
      "--role",
      "worker",
      "--cwd",
      repo,
      "--parent-session",
      "dead-turn-session",
      "--task",
      "Fix the flaky test.",
      "--worker",
      "codex",
      "--reviewer",
      "codex",
      "--prompt-file",
      promptFile,
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        TMPDIR: tmpRoot,
        TEMP: tmpRoot,
        TMP: tmpRoot,
        FAKE_CODEX_REPORT: report,
      },
    },
  );
  dispatches.push(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let turn;
  await vi.waitFor(
    async () => {
      turn = JSON.parse(await readFile(report, "utf8").catch(() => "null"));
      expect(turn?.pid).toBeGreaterThan(0);
      // The dispatch has recorded the child, so the kill leaves the record a recovery reads.
      const state = await readRepoState(repo).catch(() => null);
      expect(state?.lastDispatch?.turnTmpdir?.child?.pid).toBeGreaterThan(0);
    },
    { timeout: 30_000, interval: 100 },
  );
  child.kill("SIGKILL");
  await exited;
  if (!keepChild) {
    if (processExists(turn.pid)) process.kill(turn.pid, "SIGKILL");
    await vi.waitFor(() => expect(processExists(turn.pid)).toBe(false), { timeout: 5000 });
  }
  return { repo, turnDir: turn.dir, tmpRoot, childPid: turn.pid };
}

const nextCall = (repo) =>
  executeRoleCommand(withRepo(dispatchArgv(), repo), { ...basicDeps(), stdin: stdinPrompt });

// Usefulness: verifies issue #1207 acceptance 1, that the call which marks a run `interrupted`
// after its dispatch process died mid-turn removes the directory of that turn.
test("the call that marks a killed dispatch interrupted removes its turn directory", async () => {
  const { repo, turnDir, tmpRoot } = await killedDispatch();
  expect(existsSync(turnDir)).toBe(true);

  const next = await nextCall(repo);

  expect(next.exitCode).toBe(1);
  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(turnDir)).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
}, 60_000);

// Usefulness: verifies issue #1207 acceptance 2, that a recorded directory which is already gone
// does not fail the call and the run is still marked `interrupted`.
test("a recorded turn directory that is gone does not fail the interrupted mark", async () => {
  const { repo, turnDir } = await killedDispatch();
  await removePath(turnDir);

  const next = await nextCall(repo);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
}, 60_000);

// Usefulness: verifies issue #1207 acceptance 2, that a directory which replaced the recorded one
// is not followed or removed, and the run is still marked `interrupted`.
test("a directory that replaced the recorded turn directory keeps its content", async () => {
  const { repo, turnDir, tmpRoot } = await killedDispatch();
  renameSync(turnDir, join(tmpRoot, "moved"));
  mkdirSync(turnDir);
  const sentinel = join(turnDir, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");

  const next = await nextCall(repo);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(sentinel)).toBe(true);
}, 60_000);

// Usefulness: verifies issue #1207 review blocker 2, that a child of the dead dispatch which still
// runs keeps its turn directory, and the run is still marked `interrupted`.
test("a live child of the killed dispatch keeps the turn directory", async () => {
  const { repo, turnDir, childPid } = await killedDispatch({ keepChild: true });
  expect(processExists(childPid)).toBe(true);

  const next = await nextCall(repo);

  expect(next.payload.error).toContain("interrupted");
  expect((await readRepoState(repo)).lifecycle).toBe("interrupted");
  expect(existsSync(join(turnDir, "leftover.txt"))).toBe(true);
}, 60_000);
