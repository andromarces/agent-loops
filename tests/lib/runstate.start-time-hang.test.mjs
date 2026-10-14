import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vite-plus/test";
import { processStartTime } from "../../src/lib/state-lock.mjs";
import { removePath } from "../runtime-helpers.mjs";

// The start-time query runs the real command here: a fake `ps` (`powershell.exe` on
// Windows, as a `.cmd` that PATHEXT resolves) first on PATH hangs on purpose, so the bound and the end of the whole query tree are observed, not stubbed.
// On POSIX the fake runs the hanging node as a child of a shell, so the kill must reach a descendant.
const realPlatform = process.platform;
// The variable is `Path` on Windows, and a worker thread sees `process.env` as a case-sensitive copy.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
const realPath = process.env[pathKey];
let dir;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "runstate-starttime-hang-"));
  await writeFile(
    join(dir, "ps.js"),
    'require("fs").writeFileSync(process.env.FAKE_PS_PIDFILE, String(process.pid));\nsetInterval(() => {}, 1000);\n',
    "utf8",
  );
  const node = process.execPath;
  if (realPlatform === "win32") {
    await writeFile(join(dir, "powershell.exe.cmd"), `@"${node}" "%~dp0ps.js" %*\r\n`, "utf8");
  } else {
    await writeFile(
      join(dir, "ps"),
      `#!/bin/sh\n"${node}" "${join(dir, "ps.js")}" "$@"\nstatus=$?\nexit $status\n`,
      "utf8",
    );
    await chmod(join(dir, "ps"), 0o755);
  }
  process.env[pathKey] = `${dir}${delimiter}${realPath}`;
  process.env.FAKE_PS_PIDFILE = join(dir, "ps.pid");
  if (realPlatform !== "win32") {
    Object.defineProperty(process, "platform", { value: "darwin" });
  }
});

afterAll(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  process.env[pathKey] = realPath;
  delete process.env.FAKE_PS_PIDFILE;
  await removePath(dir);
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const pidFile = () => join(dir, "ps.pid");

// The pid of the hanging query process, or null when it never wrote its pid file.
async function queryPid() {
  try {
    return Number(await readFile(pidFile(), "utf8"));
  } catch {
    return null;
  }
}

// Ends a query process that the code under test left alive, so a failed assertion
// never leaks a process into the host.
afterEach(async () => {
  const pid = await queryPid();
  if (pid !== null && isAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  await rm(pidFile(), { force: true });
});

// Usefulness: verifies a hung start-time query yields null after the bound and leaves
// no query process alive, which a bare execFile timeout does not guarantee for a tree.
test("a hung start-time query returns null and leaves no query process", async (ctx) => {
  await expect(processStartTime(process.pid)).resolves.toBeNull();

  // On a loaded host the bound can fire before the fake query starts and writes its pid.
  // No process then exists to observe, so the test skips instead of passing vacuously.
  await expect
    .poll(queryPid, { timeout: 2000 })
    .not.toBeNull()
    .catch(() => ctx.skip());
  const pid = await queryPid();
  await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false);
}, 20_000);
