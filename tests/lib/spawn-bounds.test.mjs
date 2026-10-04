import { expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runGh } from "../../src/lib/ci-gate.mjs";
import { FORCE_KILL_AFTER_DELAY_MS } from "../runtime-helpers.mjs";
import { assertGitWorkTree } from "../../src/lib/snapshot.mjs";

// Scoped exception to the TDD rule (issue #373, maintainer decision on PR #381).
// These tests assert three fields of the options handed to execa, an
// implementation detail, and no others: `timeout` (the bound value),
// `forceKillAfterDelay` (the kill timing), and `cancelSignal` (the abort wiring).
//
// - execa runs its bound and its force-kill delay on `node:timers/promises`,
//   which Vitest fake timers do not drive, so no fake clock can advance a real
//   child to 299 ms and then 300 ms.
// - No observable proof of the bound value is independent of runner load: the
//   bound fires from a timer in this process, so a late bound and a loaded runner
//   look the same in any wall-clock measurement.
//
// `killDescendants` and `cleanup` are not asserted here. The real-process tests
// in ci-gate.test.mjs and snapshot.test.mjs fail when `killDescendants` is off,
// so they cover it. `cleanup` only matters when the parent process exits, which
// none of the named behaviors involve.

function spawnedWith() {
  expect(execa).toHaveBeenCalledTimes(1);
  return execa.mock.calls[0][2];
}

// Usefulness: verifies the `gh` runner passes the configured bound to the spawn
// layer as the timeout and the force-kill delay, which is what makes a hung `gh`
// stop at the bound and not at its own end.
test("runGh hands the spawn layer its exact bound and force-kill delay", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  await runGh(["pr", "checks", "42"], ".", { timeoutMs: 300 });
  expect(spawnedWith()).toMatchObject({
    timeout: 300,
    forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
  });
});

// Usefulness: verifies the `gh` runner hands the abort signal itself to the spawn
// layer, so cancelling that signal is what cancels the child.
test("runGh hands the spawn layer the caller's abort signal", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  const controller = new AbortController();
  await runGh(["pr", "checks", "42"], ".", { signal: controller.signal });
  const options = spawnedWith();
  expect(options.cancelSignal).toBe(controller.signal);
  expect(options).not.toHaveProperty("timeout");
});

// Usefulness: verifies a status read through the `gh` runner returns the answer the
// spawn layer produced while it passes the bound and the abort signal on, so a
// runner that stops returning the answer fails here. No `gh` process starts, and
// the installed execa accepts the options in ci-gate.test.mjs (issues #320, #399).
test("runGh answers a read through the bound and signal the read passes", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "gh version 2.0.0\n", stderr: "" });
  const controller = new AbortController();
  const reply = await runGh(["--version"], ".", {
    signal: controller.signal,
    timeoutMs: 60_000,
  });
  expect(reply).toEqual({
    status: 0,
    stdout: "gh version 2.0.0\n",
    stderr: "",
    timedOut: false,
  });
  expect(spawnedWith()).toMatchObject({
    timeout: 60_000,
    forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
    cancelSignal: controller.signal,
  });
});

// Usefulness: verifies the work-tree probe passes the configured bound to the
// spawn layer as the timeout and the force-kill delay, so a hung `git` cannot add
// its own time to a caller's total limit.
test("assertGitWorkTree hands the spawn layer its exact bound and force-kill delay", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "true\n", stderr: "" });
  await assertGitWorkTree(".", { timeoutMs: 300 });
  expect(spawnedWith()).toMatchObject({
    timeout: 300,
    forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
  });
});
