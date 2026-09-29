import { expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runGh } from "../../src/lib/ci-gate.mjs";
import { FORCE_KILL_AFTER_DELAY_MS } from "../runtime-helpers.mjs";
import { assertGitWorkTree } from "../../src/lib/snapshot.mjs";

// Scoped exception to the TDD rule (issue #373, maintainer decision on PR #381):
// these tests assert the options handed to execa, an implementation detail,
// because that is the only proof of the bound value that holds on every runner.
//
// - execa runs its bound and its force-kill delay on `node:timers/promises`,
//   which Vitest fake timers do not drive, so no fake clock can advance a real
//   child to 299 ms and then 300 ms.
// - No observable proof of the bound value is independent of runner load: the
//   bound fires from a timer in this process, so a late bound and a loaded runner
//   look the same in any wall-clock measurement.
//
// The real-process tests in ci-gate.test.mjs and snapshot.test.mjs prove the other
// half: a bound that fires does kill the child.

function spawnedWith() {
  expect(execa).toHaveBeenCalledTimes(1);
  return execa.mock.calls[0][2];
}

// Usefulness: verifies the `gh` runner passes the configured bound to the spawn
// layer as the timeout, kills the process tree, and force-kills after a delay,
// which is what makes a hung `gh` stop at the bound and not at its own end.
test("runGh hands the spawn layer its exact bound and a tree kill", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  await runGh(["pr", "checks", "42"], ".", { timeoutMs: 300 });
  expect(spawnedWith()).toMatchObject({
    timeout: 300,
    forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
    killDescendants: true,
    cleanup: true,
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

// Usefulness: verifies the work-tree probe passes the configured bound to the
// spawn layer as the timeout, kills the process tree, and force-kills after a
// delay, so a hung `git` cannot add its own time to a caller's total limit.
test("assertGitWorkTree hands the spawn layer its exact bound and a tree kill", async () => {
  execa.mockReset().mockResolvedValue({ exitCode: 0, stdout: "true\n", stderr: "" });
  await assertGitWorkTree(".", { timeoutMs: 300 });
  expect(spawnedWith()).toMatchObject({
    timeout: 300,
    forceKillAfterDelay: FORCE_KILL_AFTER_DELAY_MS,
    killDescendants: true,
    cleanup: true,
  });
});
