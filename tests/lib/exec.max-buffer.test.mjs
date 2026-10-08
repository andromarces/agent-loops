import { expect, test, vi } from "vite-plus/test";

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

// Usefulness: verifies an overflow error carries no cut output, so a secret value cut mid-value
// leaves no fragment that exact-value redaction misses (issue #578). A synthetic variable stands in
// for a secret.
test.each(["stdout", "stderr"])(
  "exec overflow error on %s holds no fragment of a secret",
  async (stream) => {
    vi.stubEnv("SYNTHETIC_TEST_TOKEN", "synthetic-secret-value-0123456789");
    try {
      const script = `process.${stream}.write('x'.repeat(90) + process.env.SYNTHETIC_TEST_TOKEN)`;

      const err = await exec(process.execPath, ["-e", script], { maxBuffer: 100 }).catch((e) => e);

      expect(err).toBeInstanceOf(ExecError);
      expect(err.isMaxBuffer).toBe(true);
      for (const text of [err.message, err.stdout, err.stderr]) {
        expect(text).not.toContain("synthetic");
        expect(text).not.toContain("xxxx");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
