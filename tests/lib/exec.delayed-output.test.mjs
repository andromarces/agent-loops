import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";

// A stdout transform that holds the first line for 4.5 s, longer than the drain bound, as a slow
// consumer of the child output does.
vi.mock("execa", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    execa: (command, args, options) => {
      let first = true;
      return real.execa(command, args, {
        ...options,
        stdout: [
          {
            async *transform(line) {
              if (first) {
                first = false;
                await sleep(4500);
              }
              yield line;
            },
          },
        ],
      });
    },
  };
});

import { exec } from "../../src/lib/exec.mjs";

// Usefulness: output that the child wrote before it exited must reach the caller, even when the
// consumer takes longer than the drain bound to deliver it (review of PR #1306).
test("exec keeps output that a slow stdout consumer delivers after the child exit", async () => {
  const script = 'console.log("one"); console.log("two");';
  const result = await exec(process.execPath, ["-e", script]);
  expect(result.stdout).toBe("one\ntwo");
}, 20_000);
