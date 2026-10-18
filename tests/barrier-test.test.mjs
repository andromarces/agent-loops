import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, test } from "vite-plus/test";
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

describe("createBarrierTest names the case of a test.each table", () => {
  const real = createBodyBarrier();
  const names = [];
  const barrier = {
    ...real,
    run: (body, name) => {
      names.push(name);
      return real.run(body, name);
    },
  };
  describe("a file with a table of cases", () => {
    const barrierTest = createBarrierTest({ barrier });
    barrierTest.each([["first"], ["second"]])("%s works", () => {});
  });

  // Usefulness: acceptance (#949) — a hung case of a table is named by its own title, so the bound message identifies it.
  test("each case of a table runs under its own title", () => {
    expect(names.some((name) => name.includes("first works"))).toBe(true);
    expect(names.some((name) => name.includes("second works"))).toBe(true);
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

describe("createBarrierTest keeps an exit code that a test set on purpose", () => {
  const initialExitCode = process.exitCode;
  afterAll(() => {
    process.exitCode = initialExitCode;
  });
  const barrierTest = createBarrierTest();
  barrierTest("a test sets a failure code", () => {
    process.exitCode = 17;
  });

  // Usefulness: acceptance (#949) — the reset reverts only a late body, so a real failure code stays visible.
  barrierTest("the next test still sees the failure code", () => {
    expect(process.exitCode).toBe(17);
  });
});
