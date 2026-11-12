import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import { removePath } from "../fs-helpers.mjs";

const GUARD = fileURLToPath(new URL("../../.vite-hooks/install.mjs", import.meta.url));

let dir;
afterEach(async () => {
  if (dir) await removePath(dir);
  dir = undefined;
});

/**
 * Creates a Git repository that holds a copy of the guard and a stub `vite-plus`
 * whose `bin/vp` runs `vpScript` (`null` leaves no `bin/vp`). Git reads an empty
 * global config file and no system config.
 */
async function setup({ vpScript = "process.exit(0);" } = {}) {
  dir = await mkdtemp(join(tmpdir(), "vite-hooks-guard-"));
  const repo = join(dir, "repo");
  const vitePlus = join(repo, "node_modules", "vite-plus");
  await mkdir(join(vitePlus, "bin"), { recursive: true });
  await mkdir(join(repo, ".vite-hooks"));
  await writeFile(join(vitePlus, "package.json"), '{ "name": "vite-plus" }\n');
  if (vpScript !== null) await writeFile(join(vitePlus, "bin", "vp"), `${vpScript}\n`);
  await copyFile(GUARD, join(repo, ".vite-hooks", "install.mjs"));
  const globalConfig = join(dir, "global.gitconfig");
  await writeFile(globalConfig, "");
  const env = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  await execa("git", ["init", "-q", repo], { env });
  // Process: the guard starts the stub `vp` as a child, so its exit code and signal surface here.
  const prepare = (extraEnv = {}) =>
    execa(process.execPath, [join(".vite-hooks", "install.mjs")], {
      cwd: repo,
      env: { ...env, CI: "", NODE_ENV: "", VP_GIT_HOOKS: "", ...extraEnv },
      reject: false,
    });
  return { repo, prepare };
}

const failures = [
  {
    name: "vp config exits non-zero",
    vpScript: 'console.log("child stdout"); console.error("child stderr"); process.exit(3);',
  },
  { name: "vp config is missing", vpScript: null },
  { name: "vp config ends on a signal", vpScript: 'process.kill(process.pid, "SIGTERM");' },
];

// Process: the case reads the exit code and output streams of a new process, an allowed exception.
// Usefulness: verifies the warning-only `prepare` contract on every failure path
// (exit 0, no stdout, one warning line of its own, no stack), which keeps a
// consumer install clean; no other test checks the output streams.
test.each(failures)("prepare only warns when $name", async ({ vpScript, env }) => {
  const { prepare } = await setup({ vpScript });

  const result = await prepare(env);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  const lines = result.stderr.split(/\r?\n/);
  expect(lines.filter((line) => line.startsWith("prepare:"))).toHaveLength(1);
  expect(lines.filter((line) => /^\s+at\s/.test(line))).toEqual([]);
});

// Process: the case reads the exit code and output streams of a new process, an allowed exception.
// Usefulness: verifies that a package directory outside any Git work tree, such as
// the temporary checkout of an `npm install github:...`, installs silently, so a Git
// URL install prints no hook warning; no other test runs `prepare` without a repo.
test("prepare is a silent no-op outside a Git work tree", async () => {
  const { repo, prepare } = await setup();
  await removePath(join(repo, ".git"));

  const result = await prepare();

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
