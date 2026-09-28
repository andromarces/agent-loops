import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, expect, test } from "vitest";
import { install, stablePackageRoot } from "../../src/install/installer.mjs";
import { removePath } from "../runtime-helpers.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// A directory symlink on POSIX, a junction on Windows, which needs no elevated
// rights. pnpm writes the same global link on both platforms.
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const paths = [];

afterEach(async () => {
  for (const path of paths.splice(0)) {
    await removePath(path);
  }
});

/**
 * Copies the package into a pnpm global virtual store and links it into the
 * global `node_modules`, the layout `pnpm add -g` produces: the store entry name
 * carries the version, the link beside `.pnpm` does not.
 */
async function pnpmGlobal(globalDir, version) {
  const store = join(
    globalDir,
    "node_modules",
    ".pnpm",
    `@andromarces+agent-loops@${version}`,
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
  await mkdir(store, { recursive: true });
  await cp(join(REPO_ROOT, "src"), join(store, "src"), { recursive: true });
  await cp(join(REPO_ROOT, "docs"), join(store, "docs"), { recursive: true });
  // The one runtime dependency, beside the package the way pnpm places it.
  await symlink(
    join(REPO_ROOT, "node_modules", "execa"),
    join(dirname(dirname(store)), "execa"),
    LINK_TYPE,
  );
  const link = join(globalDir, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(link), { recursive: true });
  await symlink(store, link, LINK_TYPE);
  return { link, store };
}

// Usefulness: verifies acceptance #305 — a `pnpm add -g` upgrade deletes the
// version-named store directory the package was installed from, so the guard
// command and the skill's CLI invocation must name the global `node_modules`
// link that the upgrade replaces in place, not the store directory it deletes.
test("hooks installed from a pnpm global store survive a global upgrade", async () => {
  const globalDir = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-global-"));
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-home-"));
  paths.push(globalDir, home);
  const { link, store } = await pnpmGlobal(globalDir, "0.3.0");

  await execa(
    process.execPath,
    [join(link, "src", "cli.mjs"), "install", "--harness", "claude", "--yes"],
    {
      env: { ...process.env, AGENT_LOOP_HOME: home },
    },
  );

  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const guardPath = command.match(/^node "(.+)"$/)?.[1];
  expect(guardPath).toBe(join(link, "src", "hook", "parent-guard.mjs"));

  const skill = await readFile(join(home, ".claude", "skills", "agent-loop", "SKILL.md"), "utf8");
  const cliPath = skill.match(/node "([^"]*src\/cli\.mjs)"/)?.[1];
  expect(cliPath).toBe(join(link, "src", "cli.mjs").replaceAll("\\", "/"));

  // The upgrade: the old store directory is deleted and a new one takes its
  // place under a new version name, and the link points at the new package.
  await removePath(store);
  await rm(link, { force: true });
  await pnpmGlobal(globalDir, "0.4.0");
  expect(existsSync(store)).toBe(false);

  expect(existsSync(guardPath)).toBe(true);
  expect(existsSync(cliPath)).toBe(true);
});

// Usefulness: verifies the negative of the pnpm case — an npm global root, a
// clone, and a store layout with no `node_modules` link carry no version in
// their path, so the rendered root stays the resolved one instead of a path that
// does not exist.
test("a root without a pnpm store link is rendered unchanged", async () => {
  const globalDir = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-nolink-"));
  paths.push(globalDir);
  const { link, store } = await pnpmGlobal(globalDir, "0.3.0");
  await rm(link, { force: true });

  expect(stablePackageRoot(store)).toBe(store);
  // An npm global root, and a clone, carry no version and no `.pnpm`.
  expect(stablePackageRoot(join(globalDir, "lib", "node_modules", "agent-loops"))).toBe(
    join(globalDir, "lib", "node_modules", "agent-loops"),
  );
  expect(stablePackageRoot(REPO_ROOT)).toBe(REPO_ROOT);
});

// Usefulness: verifies the #205 refusal still fires when a dlx layout does carry
// the link the stable rewrite needs, because the rewritten path stays inside the
// dlx cache and remains deletable.
test("a dlx cache root stays refused after the stable rewrite", async () => {
  const cache = await mkdtemp(join(tmpdir(), "agent-loop-dlx-cache-"));
  paths.push(cache);
  const nodeModules = join(
    cache,
    "dlx",
    "0dd49d4f3230c83239c085437bfea068",
    "mtwi",
    "node_modules",
  );
  const store = join(
    nodeModules,
    ".pnpm",
    "@andromarces+agent-loops@0.3.0",
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
  await mkdir(store, { recursive: true });
  const link = join(nodeModules, "@andromarces", "agent-loops");
  await mkdir(dirname(link), { recursive: true });
  await symlink(store, link, LINK_TYPE);

  const stable = stablePackageRoot(store);
  expect(stable).not.toBe(store);
  const error = await install({ harnesses: ["claude"], home: cache, packageRoot: stable }).then(
    () => null,
    (err) => err,
  );
  expect(error?.message).toMatch(/npx|dlx/);
});
