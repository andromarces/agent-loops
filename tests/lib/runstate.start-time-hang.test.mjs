import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { processStartTime } from "../../src/lib/state-lock.mjs";
import { removePath } from "../runtime-helpers.mjs";

// The start-time query runs the real command here: a fake `ps` (`powershell.exe` on
// Windows, as a `.cmd` that PATHEXT resolves) first on PATH hangs on purpose, so the bound and the end of the whole query tree are observed, not stubbed.
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
      `#!/bin/sh\nexec "${node}" "${join(dir, "ps.js")}" "$@"\n`,
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

// Usefulness: verifies a hung start-time query yields null after the bound and leaves
// no query process alive, which a bare execFile timeout does not guarantee for a tree.
test("a hung start-time query returns null and leaves no query process", async () => {
  await expect(processStartTime(process.pid)).resolves.toBeNull();

  const pid = Number(await readFile(join(dir, "ps.pid"), "utf8"));
  await expect.poll(() => isAlive(pid), { timeout: 5000 }).toBe(false);
}, 20_000);
