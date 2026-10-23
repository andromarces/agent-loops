import { access } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { cleanup, setup } from "./role-helpers.mjs";

// Passes through to the real `mkdtemp`; one test holds a call open to pause `setup` mid-flight.
const gate = vi.hoisted(() => ({ real: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  gate.real = actual.mkdtemp;
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

afterEach(cleanup);

// Usefulness: acceptance (#503) — a test that calls `setup` more than once leaves no runs root behind.
test("cleanup removes every runs root that setup created", async () => {
  const first = await setup();
  const second = await setup();
  await cleanup();
  for (const root of [first, second]) {
    await expect(access(root)).rejects.toThrow();
  }
});

// Usefulness: acceptance (#1007) — a `setup` of a timed-out case that resumes after the cleanup of
// that case and the setup of the next case must not replace the next case's runs root.
test("a setup that resumes after cleanup leaves the next case's runs root alone", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  vi.mocked(mkdtemp).mockImplementationOnce(async (...args) => {
    await held;
    return gate.real(...args);
  });

  const stale = setup().catch((error) => error);
  await cleanup();
  const next = await setup();
  release();
  await stale;

  expect(process.env.AGENT_LOOP_RUNS_ROOT).toBe(next);
  await expect(access(next)).resolves.toBeUndefined();
});
