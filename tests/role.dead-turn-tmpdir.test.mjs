import { spawn, spawnSync } from "node:child_process";
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

// The pid that the fake `codex` of `scratch` wrote as its first action, or null when it never ran.
async function fakePid(scratch) {
  const pid = Number(await readFile(join(scratch, "pid.txt"), "utf8").catch(() => ""));
  return pid > 0 ? pid : null;
}

// Ends a dispatcher and everything below it. The fake `codex` is a descendant until the dispatcher
// dies, so the tree is ended first, whether or not the fake has reported yet.
function endTree(child) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // The tree is already gone.
  }
}

// Ends every spawned dispatcher and every fake `codex`, on every path of a test, a startup timeout
// included: the tree of a live dispatcher first, then the pid that each fake wrote on its own.
async function endSpawned() {
  for (const child of dispatches.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      endTree(child);
      await exited;
    }
  }
  for (const dir of scratches) {
    const pid = await fakePid(dir);
    if (pid !== null && processExists(pid)) process.kill(pid, "SIGKILL");
  }
}

afterEach(async () => {
  await endSpawned();
  await cleanup();
  for (const dir of scratches.splice(0)) await removePath(dir);
});

// A fake `codex` that writes its pid first, in a path that the test owns, then reports its
// temporary directory after `FAKE_CODEX_DELAY_MS`, leaves a file in that directory, and hangs, so a
// test can kill the dispatch that owns it mid-turn.
const FAKE_CODEX = `
const fs = require("fs");
const dir = process.env.TMPDIR;
fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
setTimeout(() => {
  fs.writeFileSync(process.env.FAKE_CODEX_REPORT, JSON.stringify({ pid: process.pid, dir }));
  fs.writeFileSync(dir + "/leftover.txt", "x");
}, Number(process.env.FAKE_CODEX_DELAY_MS));
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
async function killedDispatch({ keepChild = false, startupMs = 30_000, reportDelayMs = 0 } = {}) {
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
      // Its own process group on POSIX, so `endTree` can end the whole group.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
        TMPDIR: tmpRoot,
        TEMP: tmpRoot,
        TMP: tmpRoot,
        FAKE_CODEX_REPORT: report,
        FAKE_CODEX_PID: join(scratch, "pid.txt"),
        FAKE_CODEX_DELAY_MS: String(reportDelayMs),
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
    { timeout: startupMs, interval: 100 },
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

// Usefulness: verifies issue #1207 review item 1, that teardown ends the fake `codex` when startup
// times out before the child has reported, so a delayed report leaves no orphan.
test("teardown ends the fake codex when startup times out before its report", async () => {
  await expect(killedDispatch({ startupMs: 3000, reportDelayMs: 20_000 })).rejects.toThrow();
  const scratch = scratches.at(-1);
  const pid = await fakePid(scratch);
  expect(pid).toBeGreaterThan(0);
  expect(processExists(pid)).toBe(true);

  await endSpawned();

  await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 5000 });
}, 60_000);
