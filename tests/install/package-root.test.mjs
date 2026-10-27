import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { install } from "../../src/install/installer.mjs";
import {
  INHERITED_TMPDIR_INVALID_MESSAGE,
  installRefusal,
} from "../../src/install/package-root.mjs";
import { removePath } from "../runtime-helpers.mjs";
import {
  LINK_TYPE,
  PACKAGE_ROOT as REPO_ROOT,
  pnpm12Project,
  pnpmGlobal,
  runInstalled,
} from "./install-helpers.mjs";

const paths = [];

afterEach(async () => {
  for (const path of paths.splice(0)) {
    await removePath(path);
  }
});

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

  await runInstalled(
    join(installed, "src", "cli.mjs"),
    ["install", "--harness", "claude", "--yes"],
    {
      AGENT_LOOP_HOME: home,
    },
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

// Usefulness: verifies the acceptance of #311 end to end. The hook command must
// name the project link the bin shim calls, so a project upgrade that repoints
// that link and deletes the old store entry leaves the installed files pointing
// at a package that still exists.
test("hooks installed in a pnpm 12 project layout survive an upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-project-home-"));
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-project-")));
  const pnpmHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-store-"));
  paths.push(home, project, pnpmHome);
  const hash = "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d";
  const before = await pnpm12Project(pnpmHome, project, { hash, version: "0.3.0" });

  // The path the bin shim passes to node: the project link, not the store entry
  // Node resolves it to.
  await runInstalled(
    join(before.linked, "src", "cli.mjs"),
    ["install", "--harness", "claude", "--yes"],
    { AGENT_LOOP_HOME: home },
  );

  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  const guardPath = settings.hooks.PreToolUse[0].hooks[0].command.match(/^node "(.+)"$/)?.[1];
  expect(guardPath).toBe(join(before.linked, "src", "hook", "parent-guard.mjs"));

  // The upgrade: a new store entry takes the new version, the link is repointed
  // at it, and pnpm deletes the old store entry. The rendered path must still be
  // the link, not the store entry, or the install is stale again.
  await rm(before.linked, { force: true });
  const after = await pnpm12Project(pnpmHome, project, { hash, version: "0.4.0" });
  await removePath(before.store);
  expect(existsSync(before.store)).toBe(false);
  expect(existsSync(guardPath)).toBe(true);
  expect(existsSync(join(after.linked, "src", "hook", "parent-guard.mjs"))).toBe(true);
});

// Usefulness: verifies --version resolves in an installed pnpm layout, where the
// package directory holds src, docs, and package.json and nothing else.
test("--version prints the package version from an installed layout", async () => {
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-version-global-"));
  paths.push(globalHome);
  const { linked } = await pnpmGlobal(join(globalHome, "global", "v11"), {
    id: "637c-18d963de1bc57d7c-0",
    hash: null,
    version: "0.3.0",
  });
  const { version } = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const { stdout } = await runInstalled(join(linked, "src", "cli.mjs"), ["--version"]);
  expect(stdout).toBe(version);
});

/**
 * Fails unless every runtime dependency that package.json lists resolves through the link
 * beside the package in `store`, not through an ancestor `node_modules`. `--preserve-symlinks`
 * keeps the link path in the resolved URL, which a real path would hide.
 */
async function assertDependenciesResolve(store) {
  const { dependencies } = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const probe = join(store, "src", "resolve-dependency.mjs");
  await writeFile(probe, "console.log(import.meta.resolve(process.argv[2]));\n");
  // Node resolves the probe, the main module, to its real path, so the expectation starts there.
  const modules = realpathSync(dirname(dirname(store)));
  for (const name of Object.keys(dependencies)) {
    const { stdout } = await runInstalled(probe, [name], {}, ["--preserve-symlinks"]);
    const link = join(modules, name) + sep;
    expect(fileURLToPath(stdout).startsWith(link)).toBe(true);
  }
}

// Usefulness: verifies the installed layout resolves every runtime dependency that
// package.json lists through its own link, so a dependency the fixture omits fails here
// even when no module on the `--version` path imports it.
test("an installed layout resolves every runtime dependency package.json lists", async () => {
  // macOS hands out a temporary directory through a symlink (`/var` points at
  // `/private/var`), so the fixture is reached through a link on every platform.
  const real = await mkdtemp(join(tmpdir(), "agent-loop-deps-global-"));
  const globalHome = `${real}-link`;
  await symlink(real, globalHome, LINK_TYPE);
  paths.push(real, globalHome);
  const { store } = await pnpmGlobal(join(globalHome, "global", "v11"), {
    id: "637c-18d963de1bc57d7c-0",
    hash: null,
    version: "0.3.0",
  });
  await assertDependenciesResolve(store);
});

// Usefulness: verifies a dependency that only an ancestor `node_modules` provides does not
// pass for a link beside the package, so a parent directory cannot hide an omitted link.
test("a dependency provided by an ancestor node_modules does not satisfy the installed layout", async () => {
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-deps-ancestor-"));
  paths.push(globalHome);
  const { installDir, store } = await pnpmGlobal(join(globalHome, "global", "v11"), {
    id: "637c-18d963de1bc57d7c-0",
    hash: null,
    version: "0.3.0",
    omit: ["yaml"],
  });
  await symlink(
    join(REPO_ROOT, "node_modules", "yaml"),
    join(installDir, "node_modules", "yaml"),
    LINK_TYPE,
  );
  await expect(assertDependenciesResolve(store)).rejects.toThrow();
});

// Usefulness: verifies `install` fails closed on an inherited-list value that is present but not a
// list of absolute paths, and keeps accepting a stable root for an absent or valid value.
test.each([
  ["", true],
  ["{oops", true],
  ['"text"', true],
  ["[1]", true],
  ['["relative"]', true],
  ["[]", false],
  [undefined, false],
])("install refuses a stable root for the inherited list %j: %s", async (value, refused) => {
  const saved = process.env.AGENT_LOOP_INHERITED_TMPDIR;
  const stable = join(REPO_ROOT, "node_modules", "pkg");
  try {
    if (value === undefined) delete process.env.AGENT_LOOP_INHERITED_TMPDIR;
    else process.env.AGENT_LOOP_INHERITED_TMPDIR = value;
    expect(installRefusal(stable)).toBe(refused ? INHERITED_TMPDIR_INVALID_MESSAGE : null);
    if (refused) {
      await expect(install({ packageRoot: stable, dryRun: true })).rejects.toThrow(
        INHERITED_TMPDIR_INVALID_MESSAGE,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.AGENT_LOOP_INHERITED_TMPDIR;
    else process.env.AGENT_LOOP_INHERITED_TMPDIR = saved;
  }
});
