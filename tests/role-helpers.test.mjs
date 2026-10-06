import { access } from "node:fs/promises";
import { afterEach, expect, test } from "vite-plus/test";
import { cleanup, setup } from "./role-helpers.mjs";

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
