import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { readTextOrNull } from "../../src/install/fsutil.mjs";
import { buildTargets } from "../../src/install/targets.mjs";
import { removePath } from "../fs-helpers.mjs";

const homes = [];

export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), "agent-loop-install-home-"));
  trackHome(home);
  return home;
}

// Registers a directory that `cleanupHomes` removes after the test.
export function trackHome(path) {
  homes.push(path);
}

export async function cleanupHomes() {
  for (const home of homes) {
    await removePath(home);
  }
  homes.length = 0;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export { readTextOrNull as readText };

export function claudeSeed() {
  return {
    permissions: { allow: ["Bash"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }],
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo post" }] }],
    },
  };
}

export function codexSeed() {
  return {
    description: "my hooks",
    hooks: {
      PreToolUse: [{ matcher: "^shell$", hooks: [{ type: "command", command: "echo unrelated" }] }],
    },
  };
}

export function antigravitySeed() {
  return {
    "other-group": {
      PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: "echo x" }] }],
    },
  };
}

export async function targetPaths(harness, home, extra = {}) {
  const targets = await buildTargets(harness, { home, packageRoot: PACKAGE_ROOT, ...extra });
  return targets;
}

// The guard the harness owns is present in its settings file.
export async function guardIsInstalled(home, harness) {
  const target = (await targetPaths(harness, home)).settings[0];
  const settings = JSON.parse(await readTextOrNull(target.path));
  if (target.locator.kind === "key") {
    return isDeepStrictEqual(settings[target.locator.key], target.entry);
  }
  const list = target.locator.path.reduce((node, key) => node?.[key], settings);
  return Array.isArray(list) && list.some((entry) => isDeepStrictEqual(entry, target.entry));
}

// The resolved CLI invocation an installed skill carries: the CLI by absolute
// path, so it runs without an `agent-loop` PATH lookup.
export function cliInvocation() {
  const cli = join(PACKAGE_ROOT, "src", "cli.mjs").replaceAll("\\", "/");
  return `node "${cli}"`;
}

export function gateCommand(harness) {
  return `${cliInvocation()} harness-check ${harness}`;
}

// A directory symlink on POSIX, a junction on Windows, which needs no elevated
// rights. pnpm writes the same links on both platforms.
export const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

/**
 * Runs the `cli.mjs` of an installed layout with no `NODE_PATH`, which `pnpm exec` points at
 * the repository dependencies, so the layout resolves only the dependencies it links.
 */
export function runInstalled(cli, args, env = {}, nodeArgs = []) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_PATH"),
  );
  return execa(process.execPath, [...nodeArgs, cli, ...args], {
    env: { ...inherited, ...env },
    extendEnv: false,
  });
}

/** Copies the package into `store` and links each runtime dependency that package.json lists beside it. */
export async function populateStore(store, omit = []) {
  await mkdir(store, { recursive: true });
  await cp(join(PACKAGE_ROOT, "src"), join(store, "src"), { recursive: true });
  await cp(join(PACKAGE_ROOT, "docs"), join(store, "docs"), { recursive: true });
  await cp(join(PACKAGE_ROOT, "package.json"), join(store, "package.json"));
  const { dependencies } = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"));
  // Beside the package the way pnpm places each dependency.
  const modules = dirname(dirname(store));
  for (const name of Object.keys(dependencies).filter((dep) => !omit.includes(dep))) {
    const link = join(modules, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(PACKAGE_ROOT, "node_modules", name), link, LINK_TYPE);
  }
}

/**
 * Builds a pnpm global install directory, verified against a real `pnpm add -g`
 * with a temp PNPM_HOME: `<global>/v11/<id>` holds the virtual store, links the
 * package into its own `node_modules`, and pnpm 12 also links that whole
 * directory to `<global>/v11/<hash>`, the path the bin shim calls. An older pnpm
 * global layout has no such hash link, so `hash` is optional.
 */
export async function pnpmGlobal(v11, { id, hash, version, omit }) {
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
  await populateStore(store, omit);
  const linked = join(installDir, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  const hashLink = hash && join(v11, hash);
  if (hashLink) {
    await symlink(installDir, hashLink, LINK_TYPE);
  }
  return { hashLink, installDir, linked, store };
}

/**
 * Builds a pnpm 12 project layout, verified against a real pnpm 12.7.0 `pnpm add`
 * in a temp project: the package is linked from the global virtual store at
 * `store/v11/links/<name>/<version>/<hash>/node_modules/<name>`, and
 * `<project>/node_modules/.pnpm` holds only `lock.yaml` and `node_modules`, so no
 * `.pnpm` directory names a store entry. The bin shim calls the package through
 * the project link, which is the path the script is given.
 */
export async function pnpm12Project(pnpmHome, project, { hash, version }) {
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
  await populateStore(store);
  const linked = join(project, "node_modules", "@andromarces", "agent-loops");
  await mkdir(dirname(linked), { recursive: true });
  await symlink(store, linked, LINK_TYPE);
  // The project virtual store holds no store entry of its own.
  await mkdir(join(project, "node_modules", ".pnpm", "node_modules"), { recursive: true });
  return { linked, store };
}
