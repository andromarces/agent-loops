import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, test } from "vite-plus/test";
import { killTreeOnExit } from "../../src/lib/exec-tree.mjs";
import { removePath } from "../runtime-helpers.mjs";

const EXEC_TREE_URL = new URL("../../src/lib/exec-tree.mjs", import.meta.url).href;
const EXECA_URL = import.meta.resolve("execa");
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

/**
 * Runs `script` as a Node process and resolves when it has exited. On Windows, `Win32_Process.Create`
 * starts it outside the process tree of the test runner. In a probe on Windows 11, a parent that
 * the runner spawned lost its nested run the moment it exited, with or without the fix, so that
 * parent cannot show the defect of issue #612. A parent that a user shell starts shows it.
 */
async function runToExit(script) {
  if (process.platform !== "win32") {
    return (await execa(process.execPath, [script], { reject: false })).exitCode;
  }
  const commandLine = `"${process.execPath}" "${script}"`;
  const created = await execa("powershell", [
    "-NoProfile",
    "-Command",
    `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${commandLine}'}).ProcessId`,
  ]);
  const parentPid = Number(created.stdout.trim());
  expect(await waitUntil(() => !isAlive(parentPid), 30000)).toBe(true);
}

// Usefulness: acceptance (#612) — a parent that exits through `process.exit` while a nested
// run is live leaves no process of that run. Windows `taskkill /T` cannot find the descendants of a
// process that already exited, and execa cleanup starts it without waiting, so only a kill that
// finishes inside the exit handler covers this row. Not redundant: the timeout row is covered by
// tmpdir-isolation.test.mjs, and no other test exits the parent early.
test("a parent that exits with a nested run live leaves no process of that run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "exec-tree-"));
  let nestedPid;
  try {
    const pidFile = join(dir, "nested.pid");
    // The shell starts the child, and the child starts a grandchild that records its pid. The chain
    // is as deep as the nested `pnpm exec vp` run of issue #612, and a plain child with no shell
    // does not show the defect. Both processes end on their own after 60 s if a failure leaves them.
    await writeFile(
      join(dir, "hang.cjs"),
      [
        'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "child.cjs"),
      [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" });',
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
    const command = [process.execPath, join(dir, "child.cjs"), join(dir, "hang.cjs"), pidFile]
      .map((part) => `"${part}"`)
      .join(" ");
    const failedFile = join(dir, "failed.txt");
    await writeFile(
      join(dir, "parent.mjs"),
      [
        `import { execa } from ${JSON.stringify(EXECA_URL)};`,
        `import { killTreeOnExit } from ${JSON.stringify(EXEC_TREE_URL)};`,
        'import { existsSync, writeFileSync } from "node:fs";',
        `const run = killTreeOnExit(execa(${JSON.stringify(command)}, { shell: true, cwd: ${JSON.stringify(dir)}, reject: false, cleanup: true, killDescendants: true }));`,
        // The nested run ended before it recorded a pid: report why, so a CI failure names the cause.
        `run.then((r) => { if (!existsSync(${JSON.stringify(pidFile)})) { writeFileSync(${JSON.stringify(failedFile)}, String(r.shortMessage ?? r.message ?? r.exitCode)); process.exit(3); } });`,
        `setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 50);`,
        "setTimeout(() => process.exit(2), 20000);",
      ].join("\n"),
    );

    await runToExit(join(dir, "parent.mjs"));
    const failed = await readFile(failedFile, "utf8").catch(() => "");
    expect(failed).toBe("");

    nestedPid = Number(await readFile(pidFile, "utf8"));
    expect(await waitUntil(() => !isAlive(nestedPid), 8000)).toBe(true);
  } finally {
    if (nestedPid && isAlive(nestedPid)) process.kill(nestedPid, "SIGKILL");
    await removePath(dir);
  }
}, 60000);

// Usefulness: the helper must not break a caller that holds no child process, such as a spawn that
// failed. Not redundant: spawn-bounds.test.mjs mocks execa with a promise that has no pid.
test("a subprocess with no pid passes through unchanged", () => {
  const failed = Promise.resolve({ exitCode: 1 });
  expect(killTreeOnExit(failed)).toBe(failed);
});
