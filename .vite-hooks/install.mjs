// vite-plus is a devDependency, so a registry or consumer install without it must
// still succeed when npm runs the `prepare` script. Skip in CI, in production, and
// when VP_GIT_HOOKS=0, and treat a missing vite-plus as a successful no-op. Any
// other failure only warns on stderr: `prepare` never fails an install.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { CI, NODE_ENV, VP_GIT_HOOKS } = process.env;
if (CI === "true" || NODE_ENV === "production" || VP_GIT_HOOKS === "0") process.exit(0);

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
// Real path of the nearest existing ancestor, plus the missing tail, so a path
// that does not exist yet still compares equal through a symlinked parent or a
// Windows 8.3 short name (the native call expands both).
const real = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

try {
  let manifest;
  try {
    manifest = import.meta.resolve("vite-plus/package.json");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") process.exit(0);
    throw error;
  }

  // A clone set up under Husky keeps a local core.hooksPath of .husky/_, so
  // `vp config` would skip the install and every hook would stay a silent no-op.
  // Clear only that local value, in any spelling that resolves to <repo>/.husky/_.
  const local = git("config", "--local", "--get", "core.hooksPath");
  const root = git("rev-parse", "--show-toplevel").stdout?.trim();
  const value = local.stdout?.replace(/\r?\n$/, "");
  if (local.status === 0 && root && real(resolve(root, value)) === real(resolve(root, ".husky/_")))
    git("config", "--local", "--fixed-value", "--unset", "core.hooksPath", value);

  // --no-agent: `vp config` otherwise can rewrite a marked section of AGENTS.md and CLAUDE.md.
  const vp = fileURLToPath(new URL("bin/vp", manifest));
  const result = spawnSync(process.execPath, [vp, "config", "--no-agent"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`vp config exited with ${result.status ?? result.signal}`);
} catch (error) {
  console.warn(`prepare: Git hooks not installed: ${error.message}`);
}
