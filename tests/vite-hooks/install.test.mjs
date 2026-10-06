import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, expect, test } from "vite-plus/test";
import { removePath } from "../runtime-helpers.mjs";

const GUARD = fileURLToPath(new URL("../../.vite-hooks/install.mjs", import.meta.url));

let dir;
afterEach(async () => {
  if (dir) await removePath(dir);
  dir = undefined;
});

/**
 * Creates a Git repository that holds a copy of the guard and a stub
 * `vite-plus` whose `bin/vp` exits with `vpExit`. Git reads an empty global
 * config file and no system config, so a test sets each scope explicitly.
 */
async function setup({ vpExit = 0 } = {}) {
  dir = await mkdtemp(join(tmpdir(), "vite-hooks-guard-"));
  const repo = join(dir, "repo");
  const vitePlus = join(repo, "node_modules", "vite-plus");
  await mkdir(join(vitePlus, "bin"), { recursive: true });
  await mkdir(join(repo, ".vite-hooks"));
  await writeFile(join(vitePlus, "package.json"), '{ "name": "vite-plus" }\n');
  await writeFile(join(vitePlus, "bin", "vp"), `process.exit(${vpExit});\n`);
  await copyFile(GUARD, join(repo, ".vite-hooks", "install.mjs"));
  const globalConfig = join(dir, "global.gitconfig");
  await writeFile(globalConfig, "");
  const env = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  await execa("git", ["init", "-q", repo], { env });
  const git = (...args) => execa("git", args, { cwd: repo, env, reject: false });
  const prepare = (extraEnv = {}) =>
    execa(process.execPath, [join(".vite-hooks", "install.mjs")], {
      cwd: repo,
      env: { ...env, CI: "", NODE_ENV: "", VP_GIT_HOOKS: "", ...extraEnv },
      reject: false,
    });
  return { repo, git, prepare };
}

// Usefulness: verifies that `prepare` never fails an install when the hook
// dispatcher fails, which no other test covers (ADR 0004 guard contract).
test("prepare exits 0 and warns when vp config fails", async () => {
  const { prepare } = await setup({ vpExit: 3 });

  const result = await prepare();

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toMatch(/hooks/i);
});

// Usefulness: verifies that the Husky migration leaves every core.hooksPath that
// is not the local Husky path, so a user's own hooks setting survives `prepare`
// even when a Husky value from another scope is the effective one.
test("prepare keeps a custom local hooks path and a Husky path of another scope", async () => {
  const { git, prepare } = await setup();
  await git("config", "--global", "core.hooksPath", ".husky/_");
  await git("config", "--local", "core.hooksPath", ".githooks");

  await prepare({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: ".husky/_",
  });

  expect((await git("config", "--global", "core.hooksPath")).stdout).toBe(".husky/_");
  expect((await git("config", "--local", "core.hooksPath")).stdout).toBe(".githooks");
});

const huskyForms = [".husky/_", ".husky/_/", "./.husky/_", "<repo>/.husky/_"];
if (process.platform === "win32") huskyForms.push(".husky\\_", "<repo>\\.husky\\_\\");

// Usefulness: verifies that every spelling of the local Husky path is cleared, so
// `vp config` can install the dispatcher instead of leaving hooks inactive.
test.each(huskyForms)("prepare clears the local Husky hooks path %s", async (form) => {
  const { repo, git, prepare } = await setup();
  await git("config", "--local", "core.hooksPath", form.replace("<repo>", repo));

  await prepare();

  expect((await git("config", "--local", "core.hooksPath")).exitCode).toBe(1);
});
