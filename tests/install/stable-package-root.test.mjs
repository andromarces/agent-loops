import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  await cp(join(REPO_ROOT, "package.json"), join(store, "package.json"));
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
  await cp(join(REPO_ROOT, "package.json"), join(store, "package.json"));
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

/**
 * Builds a pnpm 12 project layout, verified against a real pnpm 12.7.0 `pnpm add`
 * in a temp project: the package is linked from the global virtual store at
 * `store/v11/links/<name>/<version>/<hash>/node_modules/<name>`, and
 * `<project>/node_modules/.pnpm` holds only `lock.yaml` and `node_modules`, so no
 * `.pnpm` directory names a store entry. The bin shim calls the package through
 * the project link, which is the path the script is given.
 */
async function pnpm12Project(pnpmHome, project, { hash, version }) {
  const store = join(
    pnpmHome,
    "store",
    "v11",
    "links",
    "@andromarces",
    "agent-loops",
    version,
    hash,
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
  await mkdir(store, { recursive: true });
  await cp(join(REPO_ROOT, "src"), join(store, "src"), { recursive: true });
  await cp(join(REPO_ROOT, "docs"), join(store, "docs"), { recursive: true });
  await cp(join(REPO_ROOT, "package.json"), join(store, "package.json"));
  // The one runtime dependency, beside the package the way pnpm places it.
  await symlink(
    join(REPO_ROOT, "node_modules", "execa"),
    join(dirname(dirname(store)), "execa"),
    LINK_TYPE,
  );
  const linked = join(project, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  // The project virtual store holds no store entry of its own.
  await mkdir(join(project, "node_modules", ".pnpm", "node_modules"), { recursive: true });
  return { linked, store };
}

// Usefulness: verifies the pnpm 12 project layout of #311, which no other case
// reaches. The store path names the package by version and no `.pnpm` directory
// sits above it, so only the script path the bin shim calls names the project.
// Without that script path there is nothing stable to render, and the resolved
// path stays.
test("a pnpm 12 project layout renders the project link its script path names", async () => {
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-project-")));
  const pnpmHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-store-"));
  paths.push(project, pnpmHome);
  const hash = "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d";
  const { linked, store } = await pnpm12Project(pnpmHome, project, { hash, version: "0.4.0" });

  expect(stablePackageRoot(store)).toBe(store);
  expect(stablePackageRoot(store, join(linked, "src", "cli.mjs"))).toBe(linked);
  // A script path that does not name the package, such as one reached through the
  // store itself, renders the resolved path.
  expect(stablePackageRoot(store, join(store, "src", "cli.mjs"))).toBe(store);
});

/**
 * Installs the Claude harness into a throwaway home and returns the full guard
 * command string written into `settings.json`. Asserting the whole command rather
 * than an extracted root covers the exact bytes a harness runs. The home is a temp
 * directory, never the real user config.
 */
async function renderedGuardCommand(home, packageRoot) {
  await install({ harnesses: ["claude"], home, packageRoot });
  const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
  return settings.hooks.PreToolUse[0].hooks[0].command;
}

/** The guard command a package root is expected to render. */
function guardCommandFor(packageRoot) {
  return `node "${join(packageRoot, "src", "hook", "parent-guard.mjs")}"`;
}

/**
 * Builds a pnpm 12 project layout and returns a throwaway home beside it. The
 * layout is the one `pnpm12Project` builds, so each test below starts from the
 * same shape a real `pnpm add` under pnpm 12 produces.
 */
async function pnpm12Fixture() {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-render-home-"));
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-render-project-")));
  const pnpmHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-render-store-"));
  paths.push(home, project, pnpmHome);
  const layout = await pnpm12Project(pnpmHome, project, {
    hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
    version: "0.4.0",
  });
  return { home, project, ...layout };
}

// Usefulness: verifies the valid case renders the whole project-link guard command,
// which is what a real pnpm 12 project bin shim produces. The cases below each
// protect one precondition of this one, so it is the baseline they are compared
// against.
test("a pnpm 12 project link renders the whole guard command", async () => {
  const { home, linked, store } = await pnpm12Fixture();

  const command = await renderedGuardCommand(
    home,
    stablePackageRoot(store, join(linked, "src", "cli.mjs")),
  );
  expect(command).toBe(guardCommandFor(linked));
  // The store path must not appear anywhere in the command the harness runs.
  expect(command).not.toContain("0.4.0");
});

// Usefulness: verifies a script path naming another package renders the resolved
// path. The sibling package sits in the same `node_modules` that holds the real
// link, so a lookup that searched parent directories for any link to this package
// would pick that link up and render a path this invocation never named.
test("a foreign script path renders the resolved path, not a project link", async () => {
  const { home, linked, project, store } = await pnpm12Fixture();
  const foreign = join(project, "node_modules", "other-package", "src", "cli.mjs");
  await mkdir(dirname(foreign), { recursive: true });
  await writeFile(foreign, "// not this package\n");
  // The real link is present in the very `node_modules` the foreign path sits under.
  expect(existsSync(join(project, "node_modules", "@andromarces", "agent-loops"))).toBe(true);

  const root = stablePackageRoot(store, foreign);
  expect(root).toBe(store);
  expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(store));
  // The real link is still the answer for the real script path.
  expect(stablePackageRoot(store, join(linked, "src", "cli.mjs"))).toBe(linked);
});

// Usefulness: verifies the junction case. The store sits under a `node_modules`
// that also holds a link resolving to this package, so a lookup that searched parent
// directories returned that link even though the invocation path reached the store
// directly and never named it. Rendering it would write a path the invocation did
// not name, so the resolved path must be used instead.
test("a link in a parent node_modules renders the resolved path", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-junction-home-"));
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-junction-")));
  paths.push(home, project);
  const modules = join(project, "node_modules");
  const { store } = await pnpm12Project(modules, project, {
    hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
    version: "0.4.0",
  });
  // The link a parent-directory search would reach: live, and resolving to this
  // package, so only the invocation path keeps it from being selected.
  const parentLink = join(modules, "@andromarces", "agent-loops");
  expect(realpathSync(parentLink)).toBe(realpathSync(store));

  // The invocation path reached the store itself and names no other project.
  const root = stablePackageRoot(store, join(store, "src", "cli.mjs"));
  expect(root).toBe(store);
  expect(root).not.toBe(parentLink);
  expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(store));
});

// Usefulness: verifies a nested `node_modules` chain picks the innermost link, which
// is the one the script was called through. The outer link also resolves to this
// package, so picking either link by its position in the path rather than by depth
// would render a path the script did not come through.
test("a nested chain renders the innermost link", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-nested-home-"));
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-nested-")));
  paths.push(home, project);
  const { store } = await pnpm12Project(join(project, "pnpm-home"), project, {
    hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
    version: "0.4.0",
  });
  // `pnpm12Project` links the package under the project, and a nested dependency
  // links it again, so both links resolve to it.
  const outer = join(project, "node_modules", "@andromarces", "agent-loops");
  const inner = join(outer, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(inner), { recursive: true });
  await symlink(store, inner, LINK_TYPE);
  expect(realpathSync(outer)).toBe(realpathSync(store));
  expect(realpathSync(inner)).toBe(realpathSync(store));

  const root = stablePackageRoot(store, join(inner, "src", "cli.mjs"));
  expect(root).toBe(inner);
  expect(root).not.toBe(outer);
  expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(inner));
});

// Usefulness: verifies the same nested chain when only the outer link resolves to
// this package. The inner link points elsewhere, so it must be skipped and the
// outer one used, rather than the walk giving up or rendering the wrong link.
test("a nested chain renders the outer link when only it matches", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-nested2-home-"));
  const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-nested2-")));
  paths.push(home, project);
  const { store } = await pnpm12Project(join(project, "pnpm-home"), project, {
    hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
    version: "0.4.0",
  });
  // The outer link is the one `pnpm12Project` writes; the nested one resolves
  // elsewhere, so it does not qualify.
  const outer = join(project, "node_modules", "@andromarces", "agent-loops");
  const elsewhere = join(project, "other-copy");
  await cp(join(REPO_ROOT, "src"), join(elsewhere, "src"), { recursive: true });
  const inner = join(outer, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(inner), { recursive: true });
  await symlink(elsewhere, inner, LINK_TYPE);
  expect(realpathSync(outer)).toBe(realpathSync(store));
  expect(realpathSync(inner)).not.toBe(realpathSync(store));

  const root = stablePackageRoot(store, join(inner, "src", "cli.mjs"));
  expect(root).toBe(outer);
  expect(root).not.toBe(inner);
  expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(outer));
});

// Usefulness: verifies a Windows path whose root spans more than a drive letter is
// read whole, so the link under it is still found. A share is spelled
// `\\server\share\...`, and handling the path by splitting it on separators and
// rejoining drops that root, so the link is never found. A real share cannot be
// created in a test without a network share and admin rights, so this asserts the
// path handling through the rendered command for a share-shaped path, which falls
// back to the resolved path only because the share is not present. The link must
// still be recognised as the deepest `node_modules/<name>` level, which the guard
// command shows. Windows-only, since a POSIX path root is a single separator.
test.skipIf(process.platform !== "win32")(
  "a share-shaped Windows root does not lose its server and share",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-unc-home-"));
    paths.push(home);
    const project = realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-unc-")));
    paths.push(project);
    const { linked, store } = await pnpm12Project(join(project, "pnpm-home"), project, {
      hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
      version: "0.4.0",
    });
    // The same link reached through a share-shaped root. The share does not exist, so
    // the realpath check rejects it and the resolved path renders, which is the
    // documented fallback rather than a path with a mangled root.
    const share = `\\\\localhost\\${basename(project)}`;
    const shareLinked = join(share, "node_modules", "@andromarces", "agent-loops");
    expect(shareLinked.startsWith("\\\\localhost\\")).toBe(true);

    const root = stablePackageRoot(store, join(shareLinked, "src", "cli.mjs"));
    expect(root).toBe(store);
    // The fallback names the resolved path, never a path with the share root stripped.
    expect(root.startsWith("\\\\localhost\\")).toBe(false);
    expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(store));
    // The same link on the real filesystem still renders, so the root handling is
    // what the share case would use when the share exists.
    expect(stablePackageRoot(store, join(linked, "src", "cli.mjs"))).toBe(linked);
  },
);

// Usefulness: verifies a backslash inside a POSIX directory name is a literal
// character, not a separator. A project checked out under a directory such as
// `we\ird` is legal on POSIX, and treating the backslash as a separator splits the
// directory in two and loses the link. POSIX-only, since a backslash is a path
// separator on Windows and cannot appear in a directory name there.
test.skipIf(process.platform === "win32")(
  "a backslash in a POSIX directory name renders the link",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-backslash-home-"));
    const project = join(
      realpathSync(await mkdtemp(join(tmpdir(), "agent-loop-pnpm12-backslash-"))),
      "we\\ird",
    );
    paths.push(home, dirname(project));
    await mkdir(project, { recursive: true });
    const { linked, store } = await pnpm12Project(join(project, "pnpm-home"), project, {
      hash: "beacea4c4f2552abe00f58581c4a6900e467d9d2a95d9306d5f68f4d629e5f7d",
      version: "0.4.0",
    });
    // The link sits under a directory whose name holds a backslash, which POSIX
    // treats as an ordinary character.
    expect(basename(dirname(dirname(dirname(linked)))).includes("\\")).toBe(true);

    const root = stablePackageRoot(store, join(linked, "src", "cli.mjs"));
    expect(root).toBe(linked);
    expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(linked));
  },
);

// Usefulness: verifies that drive letter case does not decide the render on
// Windows, where `realpathSync` keeps the caller's spelling. A project reached
// through a lower-case drive letter is the same project, so the guard must render
// the same command as any other spelling. POSIX has no drive letter, so the case is
// Windows-only and the test asserts the positive there.
test.skipIf(process.platform !== "win32")(
  "a lower-case drive letter renders the same guard command",
  async () => {
    const { home, linked, store } = await pnpm12Fixture();
    const lowered = join(linked, "src", "cli.mjs").replace(/^([A-Z]):/, (drive) =>
      drive.toLowerCase(),
    );
    expect(lowered).not.toBe(join(linked, "src", "cli.mjs"));

    const root = stablePackageRoot(store, lowered);
    // The rendered command is byte-identical to the upper-case spelling, so the
    // output does not depend on how the project was reached.
    expect(await renderedGuardCommand(home, root)).toBe(guardCommandFor(linked));
  },
);

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
  await execa(
    process.execPath,
    [join(before.linked, "src", "cli.mjs"), "install", "--harness", "claude", "--yes"],
    { env: { ...process.env, AGENT_LOOP_HOME: home } },
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
  const { stdout } = await execa(process.execPath, [join(linked, "src", "cli.mjs"), "--version"]);
  expect(stdout).toBe(version);
});
