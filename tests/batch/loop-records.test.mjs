import { afterEach, expect, test, vi } from "vite-plus/test";
import { progress } from "../../src/batch/loop-records.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Usefulness: verifies issue #1934 — a progress line can carry external error text, so a
// secret-named environment value in it must print in its redacted form and never raw.
// Not redundant: no other test covers the redaction of the progress() stderr line.
test("a progress line redacts a secret-named environment value", () => {
  const value = "synthetic-progress-token-4c1d";
  vi.stubEnv("AGENT_LOOP_SYNTH_TOKEN", value);
  const written = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    progress(`work tree kept: https://user:${value}@example.test/repo`);
  } finally {
    spy.mockRestore();
  }
  const stderr = written.join("");

  expect(stderr).not.toContain(value);
  expect(stderr).toBe(
    "[agent-loop] batch: work tree kept: https://user:[redacted:AGENT_LOOP_SYNTH_TOKEN]@example.test/repo\n",
  );
});
