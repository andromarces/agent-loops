import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepEqual } from "../../src/install/fsutil.mjs";
import { buildTargets } from "../../src/install/harnesses.mjs";
import { removePath } from "../runtime-helpers.mjs";

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

export async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

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
  const settings = JSON.parse(await readText(target.path));
  if (target.locator.kind === "key") {
    return deepEqual(settings[target.locator.key], target.entry);
  }
  const list = target.locator.path.reduce((node, key) => node?.[key], settings);
  return Array.isArray(list) && list.some((entry) => deepEqual(entry, target.entry));
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
