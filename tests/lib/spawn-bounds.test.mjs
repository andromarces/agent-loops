import { expect, test, vi } from "vitest";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { runGh } from "../../src/lib/ci-gate.mjs";
import { assertGitWorkTree } from "../../src/lib/snapshot.mjs";

// The real-process tests prove a bound terminates its child, but a wall clock
// cannot also prove the bound's value on a loaded runner (issue #373). These
// tests prove the value without a clock: they read what the runner hands the
// spawn layer, so a late, missing, or changed bound fails on any machine.

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
    forceKillAfterDelay: 1000,
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
    forceKillAfterDelay: 1000,
    killDescendants: true,
    cleanup: true,
  });
});
