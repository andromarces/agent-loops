// Requirement (#1124): the caller cancel ends the preflight reads of `unreadableGateReason` before
// their own deadline, and the caller sees a cancel, not the warning-and-null of a failed read.
import { expect, it, vi } from "vite-plus/test";
import { unreadableGateReason } from "../../src/lib/ci-gate.mjs";

/** A `gh` that never answers until its signal aborts, then fails the way a killed child does. */
function hungGh(started) {
  return (args, cwd, { signal } = {}) =>
    new Promise((resolve) => {
      started();
      const settle = () => resolve({ status: 1, stdout: "", stderr: "gh was canceled" });
      if (signal?.aborted) return settle();
      signal?.addEventListener("abort", settle, { once: true });
    });
}

// Usefulness: verifies acceptance of #1124 — an aborted caller signal ends a hung read long before
// the 60 s deadline, and the rejection is a cancel that the CLI maps to exit 130, not a null reason.
it("a canceled caller signal ends a hung preflight read as a cancel before the deadline", async () => {
  const controller = new AbortController();
  const started = vi.fn(() => controller.abort());
  const begun = Date.now();
  await expect(
    unreadableGateReason({
      pr: 42,
      cwd: ".",
      gh: hungGh(started),
      timeoutMs: 60_000,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ isCanceled: true });
  expect(Date.now() - begun).toBeLessThan(5_000);
});

// Usefulness: verifies a run with no cancel keeps its bound — a hung read still ends at the
// deadline with a null reason, so the cancel path does not replace the timeout path.
it("a hung preflight read with no cancel still ends at the deadline with a null reason", async () => {
  const reason = await unreadableGateReason({
    pr: 42,
    cwd: ".",
    gh: hungGh(() => {}),
    timeoutMs: 50,
    signal: new AbortController().signal,
  });
  expect(reason).toBeNull();
});
