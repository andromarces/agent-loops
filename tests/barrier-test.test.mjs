import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vite-plus/test";
import { createBarrierTest } from "./barrier-test.mjs";
import { createBodyBarrier } from "./runtime-helpers.mjs";

describe("createBarrierTest names the hung test", () => {
  const barrier = createBodyBarrier({ waitMs: 50 });
  describe("a file with a test body that never ends", () => {
    const barrierTest = createBarrierTest({ barrier });
    barrierTest.fails("hung plain test", { timeout: 20 }, () => new Promise(() => {}));
  });

  // Usefulness: acceptance (#949) — a wait that reaches its bound names the hung test, not an anonymous body.
  test("the wait that reaches its bound names the hung test", async () => {
    await expect(barrier.settled()).rejects.toThrow(/hung plain test/);
  });
});

describe("createBarrierTest resets the exit code after the wait", () => {
  describe("a file with a late body that sets the exit code", () => {
    const barrierTest = createBarrierTest();
    const initialExitCode = process.exitCode;
    barrierTest.fails("a late body sets the exit code", { timeout: 20 }, async () => {
      await delay(200);
      process.exitCode = 1;
    });

    // Usefulness: acceptance (#949) — a late body cannot change the exit code that the next test reads.
    barrierTest("the next test starts with the exit code of the file", () => {
      expect(process.exitCode).toBe(initialExitCode);
    });
  });
});
