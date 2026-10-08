import { expect, test } from "vite-plus/test";

import { ExecError, exec } from "../../src/lib/exec.mjs";

// Usefulness: verifies a child that prints more than maxBuffer fails with an error that names
// the overflow, not a success with cut stdout (issue #578). Uses a real child because execa
// reports the overflow as exitCode 0 with isMaxBuffer, which a mocked result would not prove.
test("exec throws an ExecError that names a buffer overflow", async () => {
  const args = ["-e", "process.stdout.write('x'.repeat(5000))"];

  const err = await exec(process.execPath, args, { maxBuffer: 100 }).catch((e) => e);

  expect(err).toBeInstanceOf(ExecError);
  expect(err.message).toContain("buffer");
  expect(err.stdout.length).toBeLessThan(5000);
});

// Usefulness: verifies output under the limit still succeeds, so the overflow check does not
// turn ordinary runs into failures.
test("exec returns stdout that fits maxBuffer", async () => {
  const result = await exec(process.execPath, ["-e", "process.stdout.write('ok')"], {
    maxBuffer: 100,
  });

  expect(result.stdout).toBe("ok");
});
