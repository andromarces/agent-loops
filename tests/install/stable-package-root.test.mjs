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
// rights. pnpm writes the same links on both platforms.
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const paths = [];

afterEach(async () => {
  for (const path of paths.splice(0)) {
    await removePath(path);
  }
});

/**
 * Builds the pnpm 12 global layout, verified against a real `pnpm add -g` with a
 * temp PNPM_HOME: an install directory `<global>/v11/<id>` holding the virtual
 * store, and a hash-named symlink `<global>/v11/<hash>` pointing at it. The
 * symlink is the path the bin shim calls.
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
  const hashLink = join(v11, hash);
  await symlink(installDir, hashLink, LINK_TYPE);
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
  const v11 = join(globalHome, "global", "v11");
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

// Usefulness: verifies the negative of the pnpm 12 case. An npm global root, a
// clone, and a store layout with no `node_modules` link carry no version in their
// path, so the rendered root stays the resolved one instead of a path that does
// not exist.
test("a root without a pnpm store link is rendered unchanged", async () => {
  const globalHome = await mkdtemp(join(tmpdir(), "agent-loop-pnpm-nolink-"));
  paths.push(globalHome);
  const v11 = join(globalHome, "global", "v11");
  const { hashLink, installDir, linked } = await pnpmGlobal(v11, {
    id: "637c-18d963de1bc57d7c-0",
    hash: "b796b151e5ddf3298f8c49f2312abd59",
    version: "0.3.0",
  });
  // No hash symlink, so pnpm 12's stable path does not exist. The install
  // directory link is the older pnpm global layout, which a global upgrade
  // leaves in place.
  await rm(hashLink, { force: true });
  expect(
    stablePackageRoot(join(installDir, "node_modules", ".pnpm", "x@0.3.0", "node_modules", "x")),
  ).toBe(join(installDir, "node_modules", ".pnpm", "x@0.3.0", "node_modules", "x"));

  // A store with no `node_modules` link at all falls back to the resolved path.
  await rm(linked, { force: true });
  const store = join(
    installDir,
    "node_modules",
    ".pnpm",
    "@andromarces+agent-loops@0.3.0",
    "node_modules",
    "@andromarces",
    "agent-loops",
  );
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
