import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, expect, test } from "vitest";
import { install, stablePackageRoot } from "../../src/install/installer.mjs";
import { removePath } from "../runtime-helpers.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
// A directory symlink on POSIX, a junction on Windows, which needs no elevated
// rights. pnpm writes the same links on both platforms.
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const paths = [];

afterEach(async () => {
  for (const path of paths.splice(0)) {
    await removePath(path);
  }
});

/**
 * Builds a pnpm global install directory, verified against a real `pnpm add -g`
 * with a temp PNPM_HOME: `<global>/v11/<id>` holds the virtual store, links the
 * package into its own `node_modules`, and pnpm 12 also links that whole
 * directory to `<global>/v11/<hash>`, the path the bin shim calls. An older pnpm
 * global layout has no such hash link, so `hash` is optional.
 */
async function pnpmGlobal(v11, { id, hash, version }) {
  const installDir = join(v11, id);
  const store = join(
    installDir,
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
  const linked = join(installDir, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  const hashLink = hash && join(v11, hash);
  if (hashLink) {
    await symlink(installDir, hashLink, LINK_TYPE);
  }
  return { hashLink, installDir, linked, store };
}

// Usefulness: verifies acceptance #305 on the pnpm 12 layout. The version-named
// store directory and the install directory holding it are both replaced by an
// upgrade, so the guard command and the skill CLI path must name the hash-named
// symlink the bin shim calls, which the upgrade repoints.
test("hooks installed under a pnpm 12 global layout survive an upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-home-"));
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-global-"));
  paths.push(home, globalHome);
  // macOS hands out a temporary directory through a symlink (`/var` points at
  // `/private/var`), and Node resolves the installed module, so the written path
  // carries the resolved prefix. Build the expectation from the same real path.
  const v11 = join(realpathSync(globalHome), "global", "v11");
  const hash = "b796b151e5ddf3298f8c49f2312abd5909f6f7b65dedca11ee309002b3805c31";
  const before = await pnpmGlobal(v11, { id: "637c-18d963de1bc57d7c-0", hash, version: "0.3.0" });
  // The path the pnpm bin shim calls.
  const installed = join(before.hashLink, "node_modules", "@andromarces", "agent-loops");

  await execa(
    process.execPath,
    [join(installed, "src", "cli.mjs"), "install", "--harness", "claude", "--yes"],
    { env: { ...process.env, AGENT_LOOP_HOME: home } },
  );

  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const guardPath = settings.hooks.PreToolUse[0].hooks[0].command.match(/^node "(.+)"$/)?.[1];
  expect(guardPath).toBe(join(installed, "src", "hook", "parent-guard.mjs"));

  const skill = await readFile(join(home, ".claude", "skills", "agent-loop", "SKILL.md"), "utf8");
  const cliPath = skill.match(/node "([^"]*src\/cli\.mjs)"/)?.[1];
  expect(cliPath).toBe(join(installed, "src", "cli.mjs").replaceAll("\\", "/"));

  // The upgrade: a new install directory takes the new version, the hash symlink
  // is repointed at it, and pnpm deletes the old install directory.
  await rm(before.hashLink, { force: true });
  await removePath(before.installDir);
  const after = await pnpmGlobal(v11, {
    id: "b796b151e5ddf3298f8c49f2312abd59-0",
    hash,
    version: "0.4.0",
  });
  expect(existsSync(before.store)).toBe(false);
  expect(existsSync(after.store)).toBe(true);

  expect(existsSync(guardPath)).toBe(true);
  expect(existsSync(cliPath)).toBe(true);
});

/**
 * Builds a pnpm 10 global layout, verified end to end against a real pnpm 10.34.5
 * `pnpm add -g` with a temp PNPM_HOME and a temp AGENT_LOOP_HOME: `pnpm root -g`
 * reports `<global>/5/node_modules`, the virtual store is `<global>/5/.pnpm`
 * beside it, and the package is linked under that `node_modules`. An upgrade adds
 * a store entry and repoints the link. There is no install directory and no hash
 * link, which is what separates it from pnpm 12.
 */
async function pnpmGlobalLegacy(globalHome, version) {
  const root = join(globalHome, "global", "5", "node_modules");
  const store = join(
    globalHome,
    "global",
    "5",
    ".pnpm",
    `@andromarces+agent-loops@${version}`,
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
  await mkdir(store, { recursive: true });
  const linked = join(root, "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  return { linked, root, store };
}

// Usefulness: verifies the pnpm 10 fallback of #305. Its store path still names the
// package by version, so install must render the link under the `node_modules`
// that `pnpm root -g` reports, which carries no version and which an upgrade
// repoints. The package is scoped, so the rendered path has to keep the scope
// directory.
test("a pnpm 10 global layout renders its version-independent link", async () => {
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-legacy-"));
  paths.push(globalHome);
  const { linked, store } = await pnpmGlobalLegacy(globalHome, "0.3.0");

  expect(stablePackageRoot(store)).toBe(linked);
  expect(existsSync(linked)).toBe(true);

  // The upgrade: a new store entry takes the new version, the link is repointed
  // at it, and pnpm deletes the old one. The rendered path must still be the
  // link, not the store entry, or the install is stale again.
  await rm(linked, { force: true });
  const after = await pnpmGlobalLegacy(globalHome, "0.4.0");
  await removePath(store);
  expect(existsSync(store)).toBe(false);
  expect(stablePackageRoot(after.store)).toBe(after.linked);
});

/**
 * Builds a pnpm 10 project layout, verified end to end against a real pnpm 10.34.5
 * `pnpm add` in a temp project: the virtual store is `<project>/node_modules/.pnpm`
 * and the package is linked under the project `node_modules`, which carries no
 * version. An upgrade adds a store entry and repoints the link. A global install is
 * the other pnpm 10 shape, and it places both differently.
 */
async function pnpmProject(project, version) {
  const store = join(
    project,
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
  const linked = join(project, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  return { linked, store };
}

// Usefulness: verifies the project install shape of #305, which the pnpm 10 global
// case does not reach. The store path names the package by version, so install
// must render the link under the project `node_modules`, which carries no version
// and which an upgrade repoints. A version-named path here is the stale install
// #305 reports.
test("hooks installed in a pnpm 10 project layout survive an upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm10-project-home-"));
  // macOS hands out a temporary directory through a symlink (`/var` points at
  // `/private/var`), and Node resolves the installed module, so the written path
  // carries the resolved prefix. Build the layout under the same real path.
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm10-project-")));
  paths.push(home, project);
  const before = await pnpmProject(project, "0.3.0");

  await execa(
    process.execPath,
    [join(before.store, "src", "cli.mjs"), "install", "--harness", "claude", "--yes"],
    { env: { ...process.env, AGENT_LOOP_HOME: home } },
  );

  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const guardPath = settings.hooks.PreToolUse[0].hooks[0].command.match(/^node "(.+)"$/)?.[1];
  expect(guardPath).toBe(join(before.linked, "src", "hook", "parent-guard.mjs"));

  // The upgrade: a new store entry takes the new version, the link is repointed
  // at it, and pnpm deletes the old store entry. The rendered path must still be
  // the link, not the store entry, or the install is stale again.
  await rm(before.linked, { force: true });
  const after = await pnpmProject(project, "0.4.0");
  await removePath(before.store);
  expect(existsSync(before.store)).toBe(false);
  expect(stablePackageRoot(after.store)).toBe(after.linked);
  expect(existsSync(guardPath)).toBe(true);
});

// Usefulness: verifies the negative of both pnpm cases. A store with no link to
// the package, an npm global root, and a clone have no path that survives an
// upgrade, so the rendered root stays the resolved one rather than a path that
// does not exist.
test("a root with no resolvable link is rendered unchanged", async () => {
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-nolink-"));
  paths.push(globalHome);
  const v11 = join(globalHome, "global", "v11");
  const { linked, store } = await pnpmGlobal(v11, {
    id: "637c-18d963de1bc57d7c-0",
    version: "0.3.0",
  });
  await rm(linked, { force: true });

  expect(stablePackageRoot(store)).toBe(store);
  // An npm global root, and a clone, carry no version and no `.pnpm`.
  expect(stablePackageRoot(join(globalHome, "lib", "node_modules", "agent-loops"))).toBe(
    join(globalHome, "lib", "node_modules", "agent-loops"),
  );
  expect(stablePackageRoot(REPO_ROOT)).toBe(REPO_ROOT);
});

// Usefulness: verifies the #205 refusal still fires when a dlx layout does carry
// the links the stable rewrite needs, because the rewritten path stays inside the
// dlx cache and remains deletable.
test("a dlx cache root stays refused after the stable rewrite", async () => {
  const cache = await mkdtemp(join(tmpdir(), "agent-loop-dlx-cache-"));
  paths.push(cache);
  const v11 = join(cache, "dlx", "0dd49d4f3230c83239c085437bfea068", "mtwi", "global", "v11");
  const { hashLink } = await pnpmGlobal(v11, {
    id: "72a0-18d965a32ca251bc-0",
    hash: "46140decc481",
    version: "0.3.0",
  });

  const store = join(
    v11,
    "72a0-18d965a32ca251bc-0",
    "node_modules",
    ".pnpm",
    "@andromarces+agent-loops@0.3.0",
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
  const stable = stablePackageRoot(store);
  expect(stable).toBe(join(hashLink, "node_modules", "@andromarces", "agent-loops"));
  const error = await install({ harnesses: ["claude"], home: cache, packageRoot: stable }).then(
    () => null,
    (err) => err,
  );
  expect(error?.message).toMatch(/npx|dlx/);
});
