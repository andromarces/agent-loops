// vite-plus is a devDependency, so a registry or consumer install without it must
// still succeed when npm runs the `prepare` script. Skip in CI, in production, and
// when VP_GIT_HOOKS=0, and treat a missing vite-plus, or a package directory with
// no `.git` (the temporary checkout of a Git URL install), as a successful no-op.
// Contract: always exit 0, write nothing to stdout, and on any failure write one
// warning line to stderr (child stderr still passes through).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { CI, NODE_ENV, VP_GIT_HOOKS } = process.env;
if (CI === "true" || NODE_ENV === "production" || VP_GIT_HOOKS === "0") process.exit(0);
// `.git` is a directory, or a file in a linked work tree.
if (!existsSync(".git")) process.exit(0);

class StepError extends Error {}
const fail = (step, detail) => {
  throw new StepError(`${step} failed (${detail})`);
};

try {
  let manifest;
  try {
    manifest = import.meta.resolve("vite-plus/package.json");
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") process.exit(0);
    fail("resolving vite-plus", error.code ?? "unknown error");
  }

  const vp = fileURLToPath(new URL("bin/vp", manifest));
  if (!existsSync(vp)) fail("vp config", "vite-plus has no bin/vp");
  // --no-agent: `vp config` otherwise can rewrite a marked section of AGENTS.md
  // and CLAUDE.md. Child stdout goes to stderr, so `prepare` writes no stdout.
  const result = spawnSync(process.execPath, [vp, "config", "--no-agent"], {
    stdio: ["ignore", 2, 2],
  });
  if (result.error) fail("vp config", result.error.code ?? result.error.message);
  if (result.status !== 0) fail("vp config", `exited with ${result.status ?? result.signal}`);
} catch (error) {
  const reason =
    error instanceof StepError ? error.message : `unexpected error (${error?.name ?? "unknown"})`;
  process.stderr.write(
    `prepare: Git hooks not installed: ${reason.replace(/\s+/g, " ")}. Rerun with: node .vite-hooks/install.mjs\n`,
  );
}
