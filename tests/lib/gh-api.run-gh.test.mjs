import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { runGh } from "../../src/lib/gh-api.mjs";
import {
  ABORT_KILL_TEST_TIMEOUT_MS,
  BOUND_KILL_TEST_TIMEOUT_MS,
  expectAbortKillsShim,
  expectBoundKillsShim,
  removePath,
} from "../runtime-helpers.mjs";
import {} from "./ci-gate-helpers.mjs";

// Usefulness: verifies the real `gh` runner passes the installed execa only options
// that it accepts, and that the command and arguments of the read reach the spawn
// layer. The unit stubs accept any option shape, and the double in
// spawn-bounds.test.mjs replaces execa, so only the real execa catches an option
// name that it rejects, which is what made every real read fail (issue #320
// review). execa validates its options before it calls `spawn`. The stand-in
// `spawn` throws, so the call stops there and no process starts on any platform,
// where a real `gh` start is the cost a loaded Windows runner made slow (issues
// #373 and #399). A rejected option throws from `runGh` before `spawn` is reached.
//
// On Windows, execa resolves `gh` through `PATH` and `PATHEXT` before it calls
// `spawn` (node_modules/execa/lib/arguments/command-file.js, `resolvePath`, which
// reads `process.env` when the call passes no `env`). A host `gh.cmd` shim would
// make execa wrap the call in `cmd.exe /d /s /c "..."`. The call here resolves
// against a `PATH` that holds one empty `gh.exe`, with `PATHEXT` set to `.EXE`, so
// the host install does not change what `spawn` receives: the full path of that
// `gh.exe` on Windows, and the bare name elsewhere. The file is compared by its
// base name without the extension.
describe("the gh runner against the installed execa", () => {
  // The fixture is made in a hook, outside the test's own time limit, and no run
  // changes it. The directory is recorded before the file is written, so the
  // `afterAll` removes it even when the write fails.
  let bin;
  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), "gh-resolve-"));
    await writeFile(join(bin, "gh.exe"), "");
  });
  afterAll(async () => {
    if (bin) {
      await removePath(bin);
    }
  });

  test("the installed execa accepts the options the gh runner passes", async () => {
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATHEXT", ".EXE");
    const realSpawn = childProcess.spawn;
    const spawned = [];
    childProcess.spawn = (file, args) => {
      spawned.push({ file, args });
      throw new Error("stand-in spawn: no process starts");
    };
    syncBuiltinESMExports();
    try {
      const controller = new AbortController();
      const reply = await runGh(["pr", "checks", "42", "--required"], bin, {
        signal: controller.signal,
        timeoutMs: 60_000,
      });
      // execa reached `spawn`, so it accepted the options.
      expect(spawned).toHaveLength(1);
      expect(parse(spawned[0].file).name.toLowerCase()).toBe("gh");
      expect(spawned[0].args).toEqual(["pr", "checks", "42", "--required"]);
      expect(reply.status).not.toBe(0);
    } finally {
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });

  // Usefulness: verifies a call can drop named variables from the child environment (#1046), as the
  // host lookup must run without `GH_TOKEN` and `GITHUB_TOKEN`, which add github.com to the hosts
  // that `gh auth status` lists. The list adds to the `GH_DEBUG` removal of #1047, the rest of the
  // environment stays, and a call with no list keeps its token.
  test("the gh child gets no variable named in dropEnv and keeps the rest", async () => {
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATHEXT", ".EXE");
    vi.stubEnv("GH_TOKEN", "token-a");
    vi.stubEnv("GITHUB_TOKEN", "token-b");
    vi.stubEnv("GH_DEBUG", "api");
    vi.stubEnv("GH_HOST", "github.example.test");
    const realSpawn = childProcess.spawn;
    const spawned = [];
    childProcess.spawn = (file, args, options) => {
      spawned.push(options);
      throw new Error("stand-in spawn: no process starts");
    };
    syncBuiltinESMExports();
    try {
      await runGh(["auth", "status"], bin, { dropEnv: ["gh_token", "GITHUB_TOKEN"] });
      await runGh(["auth", "status"], bin);
      expect(spawned).toHaveLength(2);
      const names = (options) => Object.keys(options.env).map((name) => name.toUpperCase());
      expect(names(spawned[0])).not.toContain("GH_TOKEN");
      expect(names(spawned[0])).not.toContain("GITHUB_TOKEN");
      expect(names(spawned[0])).not.toContain("GH_DEBUG");
      expect(spawned[0].env.GH_HOST).toBe("github.example.test");
      expect(spawned[1].env.GH_TOKEN).toBe("token-a");
      expect(spawned[1].env.GITHUB_TOKEN).toBe("token-b");
    } finally {
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });

  // Usefulness: verifies `gh` never sees `GH_DEBUG` or `DEBUG`, which make it write a debug log to
  // stderr and break the exact stderr match of the protection read (issue #1047). The other
  // variables must still reach `gh`, so the token and host keep working.
  test("the gh child gets no GH_DEBUG or DEBUG and keeps the rest of the environment", async () => {
    vi.stubEnv("PATH", bin);
    vi.stubEnv("PATHEXT", ".EXE");
    vi.stubEnv("GH_DEBUG", "api");
    vi.stubEnv("DEBUG", "1");
    vi.stubEnv("GH_HOST", "github.example.test");
    const realSpawn = childProcess.spawn;
    const spawned = [];
    childProcess.spawn = (file, args, options) => {
      spawned.push(options);
      throw new Error("stand-in spawn: no process starts");
    };
    syncBuiltinESMExports();
    try {
      await runGh(["api", "repos/o/r/branches/main/protection"], bin);
      expect(spawned).toHaveLength(1);
      const names = Object.keys(spawned[0].env).map((name) => name.toUpperCase());
      expect(names).not.toContain("GH_DEBUG");
      expect(names).not.toContain("DEBUG");
      expect(spawned[0].env.GH_HOST).toBe("github.example.test");
    } finally {
      childProcess.spawn = realSpawn;
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });
});

// Usefulness: verifies the `gh` runner terminates the child when its bound
// expires, on Windows and on macOS. A real process is the only way to check that
// the kill reaches the child, because an injected runner never spawns one
// (issue #329). Termination only: the bound value is proved in
// spawn-bounds.test.mjs, so the waits here are ceilings that load cannot reach
// (issue #373).
test(
  "runGh terminates the gh child when its bound expires",
  async () => {
    const result = await expectBoundKillsShim("gh", (timeoutMs) =>
      runGh(["pr", "checks", "42", "--required"], tmpdir(), { timeoutMs }),
    );
    expect(result.timedOut).toBe(true);
  },
  BOUND_KILL_TEST_TIMEOUT_MS,
);

// Usefulness: verifies the `gh` runner terminates the child when the abort
// signal fires, which is how the read cancels a call it no longer waits for.
// The bound is off and the abort follows the shim's start, so only the signal
// can stop the child (issue #320 review).
test(
  "runGh terminates the gh child when its abort signal fires",
  async () => {
    const result = await expectAbortKillsShim("gh", (signal) =>
      runGh(["pr", "checks", "42", "--required"], tmpdir(), { signal }),
    );
    expect(result.status).not.toBe(0);
    expect(result.timedOut).toBe(false);
  },
  ABORT_KILL_TEST_TIMEOUT_MS,
);
