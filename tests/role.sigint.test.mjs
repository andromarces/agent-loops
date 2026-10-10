import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, vi } from "vite-plus/test";
import { createTempRepo, removePath, within } from "./runtime-helpers.mjs";
import { INIT_OVERRIDES } from "./role-helpers.mjs";

const ROLE = fileURLToPath(new URL("../src/role.mjs", import.meta.url));
const EXEC = fileURLToPath(new URL("../src/lib/exec.mjs", import.meta.url));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Usefulness: acceptance (#669) — a second real SIGINT during a role dispatch whose child ignores
// SIGTERM leaves no child alive, prints one cancel envelope, and exits 130. Windows has no
// signals, so the case cannot run there.
test.skipIf(process.platform === "win32")(
  "a second real SIGINT during a role dispatch kills the child, prints one envelope, and exits 130",
  async () => {
    const repo = await createTempRepo();
    const scratch = await mkdtemp(join(tmpdir(), "role-sigint-"));
    const pidFile = join(scratch, "child.pid");
    const promptFile = join(scratch, "prompt.txt");
    await writeFile(promptFile, "work it", "utf8");
    const resistant =
      'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const runner = [
      `import { main } from ${JSON.stringify(pathToFileURL(ROLE).href)};`,
      `import { exec } from ${JSON.stringify(pathToFileURL(EXEC).href)};`,
      "const stall = { async run(_state, _prompt, { signal }) {",
      `  await exec(process.execPath, ["-e", ${JSON.stringify(resistant)}, ${JSON.stringify(pidFile)}], { signal });`,
      "} };",
      "const ok = { async run() { return 'ok'; } };",
      "await main(process.argv.slice(1), { agents: { fake1: stall, fake2: ok } });",
    ].join("\n");
    let pid;
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          "--",
          "dispatch",
          "--role",
          "worker",
          "--cwd",
          repo,
          ...INIT_OVERRIDES,
          "--prompt-file",
          promptFile,
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, AGENT_LOOP_RUNS_ROOT: scratch },
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      const exited = new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 20_000, interval: 100 },
      );
      child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The first SIGINT cancels the child with SIGTERM, which it ignores.
      expect(child.exitCode).toBeNull();
      expect(isAlive(pid)).toBe(true);
      child.kill("SIGINT");
      const { code, signal } = await within(exited, 20_000, "The role exit");
      expect({ code, signal }).toEqual({ code: 130, signal: null });
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000, interval: 100 });
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ status: "error" });
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await removePath(repo);
      await removePath(scratch);
    }
  },
  60_000,
);
