// vite-plus is a devDependency, so a registry or consumer install without it must
// still succeed when npm runs the `prepare` script. Skip in CI, in production, and
// when VP_GIT_HOOKS=0, and treat a missing vite-plus as a successful no-op.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { CI, NODE_ENV, VP_GIT_HOOKS } = process.env;
if (CI === "true" || NODE_ENV === "production" || VP_GIT_HOOKS === "0") process.exit(0);

let manifest;
try {
  manifest = import.meta.resolve("vite-plus/package.json");
} catch (error) {
  if (error.code === "ERR_MODULE_NOT_FOUND") process.exit(0);
  throw error;
}

// A clone set up under Husky keeps core.hooksPath at .husky/_, so `vp config`
// would skip the install and every hook would stay a silent no-op.
const hooksPath = spawnSync("git", ["config", "core.hooksPath"], { encoding: "utf8" });
if (hooksPath.stdout?.trim() === ".husky/_")
  spawnSync("git", ["config", "--unset", "core.hooksPath"]);

// --no-agent: `vp config` otherwise can rewrite a marked section of AGENTS.md and CLAUDE.md.
const vp = fileURLToPath(new URL("bin/vp", manifest));
const result = spawnSync(process.execPath, [vp, "config", "--no-agent"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
